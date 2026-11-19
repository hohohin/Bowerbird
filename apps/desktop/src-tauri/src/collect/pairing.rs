use axum::http::HeaderMap;
use ed25519_dalek::{Signature, VerifyingKey};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const PROTOCOL: &str = "bowerbird-v2";

fn hex_bytes<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != 2 * N || !s.is_ascii() {
        return None;
    }
    let mut bytes = [0; N];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(bytes)
}

#[derive(Clone, PartialEq)]
pub struct Pair {
    origin: String,
    key: VerifyingKey,
}
impl Pair {
    fn parse(code: &str) -> Option<Self> {
        let (id, key) = code.split_once('.')?;
        if id.len() != 32 || !id.bytes().all(|byte| (b'a'..=b'p').contains(&byte)) {
            return None;
        }
        let key = VerifyingKey::from_bytes(&hex_bytes(key)?).ok()?;
        if key.is_weak() {
            return None;
        }
        Some(Self {
            origin: format!("chrome-extension://{id}"),
            key,
        })
    }
}

pub struct Pairing {
    path: PathBuf,
    state: Mutex<Access>,
}
struct Access {
    pair: Option<Pair>,
    session: uuid::Uuid,
    seen: HashMap<String, Instant>,
    interval: Instant,
    actions: usize,
    verification_window: Instant,
    verifications: usize,
}
pub struct Grant {
    session: uuid::Uuid,
    pub upload_only: bool,
}

impl Pairing {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        let pair = match std::fs::read_to_string(path) {
            Ok(code) => Pair::parse(code.trim()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => return Err(err),
        };
        Ok(Self {
            path: path.into(),
            state: Mutex::new(Access {
                pair,
                session: uuid::Uuid::new_v4(),
                seen: HashMap::new(),
                interval: Instant::now(),
                actions: 0,
                verification_window: Instant::now(),
                verifications: 0,
            }),
        })
    }

    // Only the explicit main-window command can replace trust. The copied
    // pairing code contains a public key; the private key stays in the browser.
    pub fn replace(&self, code: &str) -> Result<(), String> {
        let pair = Pair::parse(code.trim()).ok_or("请粘贴插件选项页显示的完整配对码")?;
        let mut state = self.state.lock().unwrap();
        let mut file = tempfile::NamedTempFile::new_in(self.path.parent().unwrap())
            .map_err(|e| e.to_string())?;
        file.write_all(code.trim().as_bytes())
            .and_then(|_| file.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        file.persist(&self.path).map_err(|e| e.to_string())?;
        state.pair = Some(pair);
        state.session = uuid::Uuid::new_v4();
        state.seen.clear();
        Ok(())
    }

    pub fn session(&self) -> uuid::Uuid {
        self.state.lock().unwrap().session
    }

    pub fn grant(&self, headers: &HeaderMap) -> Option<Grant> {
        use axum::http::header::{ORIGIN, SEC_WEBSOCKET_PROTOCOL};
        let origin = headers.get(ORIGIN)?.to_str().ok()?;
        let mut offers = headers
            .get(SEC_WEBSOCKET_PROTOCOL)?
            .to_str()
            .ok()?
            .split(',')
            .map(str::trim);
        if offers.next()? != PROTOCOL {
            return None;
        }
        let mut proof = offers.next()?.split('.');
        if offers.next().is_some() || proof.next()? != "bb" {
            return None;
        }
        let time = proof.next()?;
        let nonce = proof.next()?;
        let signature = Signature::from_bytes(&hex_bytes(proof.next()?)?);
        if proof.next().is_some() || hex_bytes::<16>(nonce).is_none() {
            return None;
        }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
        if now.abs_diff(time.parse::<u64>().ok()?) > 20 {
            return None;
        }
        let mut state = self.state.lock().unwrap();
        if state.verification_window.elapsed() >= Duration::from_secs(1) {
            state.verification_window = Instant::now();
            state.verifications = 0;
        }
        if state.verifications >= 48 {
            return None;
        }
        state.verifications += 1;
        let pair = state.pair.as_ref()?;
        let upload_only = origin != pair.origin;
        if upload_only
            && !(origin.starts_with("https://")
                || origin.starts_with("http://")
                || origin == "file://"
                || origin == "null")
        {
            return None;
        }
        let scope = if upload_only { "upload" } else { "extension" };
        let signed = format!("{PROTOCOL}\n{}\n{scope}\n{origin}\n{time}\n{nonce}", state.session.simple());
        pair.key.verify_strict(signed.as_bytes(), &signature).ok()?;
        let grant = Grant {
            session: state.session,
            upload_only,
        };
        state
            .seen
            .retain(|_, time| time.elapsed() < Duration::from_secs(45));
        if state.seen.len() >= 512 || state.seen.contains_key(nonce) {
            return None;
        }
        state.seen.insert(nonce.to_owned(), Instant::now());
        Some(grant)
    }

    pub fn allow_action(&self, grant: &Grant, cost: usize) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.session != grant.session {
            return false;
        }
        if state.interval.elapsed() >= Duration::from_secs(60) {
            state.interval = Instant::now();
            state.actions = 0;
        }
        if state.actions.saturating_add(cost) > 640 {
            return false;
        }
        state.actions += cost;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    fn headers(pairing: &Pairing, key: &SigningKey, origin: &str, scope: &str) -> HeaderMap {
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let signature =
            key.sign(format!("{PROTOCOL}\n{}\n{scope}\n{origin}\n{time}\n{nonce}", pairing.session().simple()).as_bytes());
        let sig: String = signature
            .to_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let mut headers = HeaderMap::new();
        headers.insert("origin", origin.parse().unwrap());
        headers.insert(
            "sec-websocket-protocol",
            format!("{PROTOCOL}, bb.{time}.{nonce}.{sig}")
                .parse()
                .unwrap(),
        );
        headers
    }
    #[test]
    fn each_connection_requires_current_pair_origin_and_unused_proof() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("pair");
        let pairing = Pairing::open(&path).unwrap();
        let key = SigningKey::from_bytes(&[39; 32]);
        let id = "abcdefghijklmnopabcdefghijklmnop";
        let code = |k: &SigningKey| {
            format!(
                "{id}.{}",
                k.verifying_key()
                    .as_bytes()
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            )
        };
        let origin = format!("chrome-extension://{id}");
        let request = headers(&pairing, &key, &origin, "extension");
        assert!(pairing.grant(&request).is_none());
        pairing.replace(&code(&key)).unwrap();
        let used = headers(&pairing, &key, &origin, "extension");
        let outstanding = headers(&pairing, &key, "https://site.test", "upload");
        assert!(pairing.grant(&used).is_some());
        let pairing = Pairing::open(&path).unwrap();
        assert!(pairing.grant(&used).is_none());
        assert!(pairing.grant(&outstanding).is_none());
        let request = headers(&pairing, &key, &origin, "extension");
        let grant = pairing.grant(&request).unwrap();
        assert!(!grant.upload_only);
        assert!(pairing.grant(&request).is_none());
        assert!(pairing.grant(&HeaderMap::new()).is_none());
        let mut page = headers(&pairing, &key, "https://site.test", "upload");
        page.insert("origin", "https://other.test".parse().unwrap());
        assert!(pairing.grant(&page).is_none());
        page.insert("origin", "https://site.test".parse().unwrap());
        assert!(pairing.grant(&page).unwrap().upload_only);
        assert!(pairing.allow_action(&grant, 640));
        assert!(!pairing.allow_action(&grant, 1));
        let page = headers(&pairing, &key, "https://site.test", "upload");
        // Re-pairing the same browser also revokes pending proofs and open sockets.
        pairing.replace(&code(&key)).unwrap();
        assert!(!pairing.allow_action(&grant, 0));
        assert!(pairing.grant(&page).is_none());
        pairing
            .replace(&code(&SigningKey::from_bytes(&[17; 32])))
            .unwrap();
        assert!(!pairing.allow_action(&grant, 0));
        assert!(pairing
            .grant(&headers(&pairing, &key, &origin, "extension"))
            .is_none());
    }
}
