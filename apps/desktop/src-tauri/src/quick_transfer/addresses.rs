//! Prefer the host's LAN route while keeping other private adapters selectable.
use if_addrs::Interface;
use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, UdpSocket},
};

pub fn available_ipv4_addresses() -> Vec<Ipv4Addr> {
    order_addresses(if_addrs::get_if_addrs().unwrap_or_default(), route_source())
}

fn route_source() -> Option<Ipv4Addr> {
    // UDP connect only selects a route and peer. No packet, DNS query or reply is used.
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(1, 1, 1, 1), 9)).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) => Some(ip),
        IpAddr::V6(_) => None,
    }
}

fn order_addresses(interfaces: Vec<Interface>, route: Option<Ipv4Addr>) -> Vec<Ipv4Addr> {
    let mut candidates: Vec<_> = interfaces
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(ip) if interface.is_oper_up() && ip.is_private() => {
                Some((is_virtual(&interface), ip))
            }
            _ => None,
        })
        .collect();
    candidates.sort_by_key(|(virtual_adapter, ip)| (*virtual_adapter, Some(*ip) != route, *ip));
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .map(|(_, ip)| ip)
        .filter(|ip| seen.insert(*ip))
        .collect()
}

fn is_virtual(interface: &Interface) -> bool {
    // These hints only affect recommendation; virtual adapters remain selectable.
    let name = interface.name.to_ascii_lowercase();
    interface.is_p2p()
        || [
            "virtual",
            "vethernet",
            "vmware",
            "wireguard",
            "tailscale",
            "zerotier",
            "wintun",
            "vpn",
        ]
        .iter()
        .any(|hint| name.contains(hint))
        || ["utun", "tun", "tap", "veth", "docker", "vmnet", "vboxnet"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use if_addrs::{IfAddr, IfOperStatus, Ifv4Addr};

    fn interface(name: &str, ip: [u8; 4], p2p: bool) -> Interface {
        Interface {
            name: name.into(),
            addr: IfAddr::V4(Ifv4Addr {
                ip: ip.into(),
                netmask: [255, 255, 255, 0].into(),
                prefixlen: 24,
                broadcast: None,
            }),
            index: None,
            oper_status: IfOperStatus::Up,
            is_p2p: p2p,
            #[cfg(windows)]
            adapter_name: name.into(),
        }
    }

    #[test]
    fn wlan_route_precedes_wsl_and_keeps_it_selectable() {
        let wifi = Ipv4Addr::new(192, 168, 1, 5);
        assert_eq!(
            order_addresses(
                vec![
                    interface(
                        "vEthernet (WSL (Hyper-V firewall))",
                        [172, 28, 192, 1],
                        false
                    ),
                    interface("WLAN", wifi.octets(), false),
                ],
                Some(wifi)
            ),
            vec![wifi, Ipv4Addr::new(172, 28, 192, 1)]
        );
    }

    #[test]
    fn default_route_chooses_between_two_normal_lan_adapters() {
        let wifi = Ipv4Addr::new(192, 168, 1, 5);
        assert_eq!(
            order_addresses(
                vec![
                    interface("Ethernet", [10, 0, 0, 8], false),
                    interface("Wi-Fi", wifi.octets(), false),
                ],
                Some(wifi)
            )[0],
            wifi
        );
    }

    #[test]
    fn vpn_default_route_does_not_displace_the_local_wifi() {
        let wifi = Ipv4Addr::new(192, 168, 1, 5);
        for (name, p2p) in [
            ("utun4", true),
            ("WireGuard", false),
            ("custom tunnel", true),
        ] {
            assert_eq!(
                order_addresses(
                    vec![
                        interface(name, [10, 8, 0, 2], p2p),
                        interface("en0", wifi.octets(), false),
                    ],
                    Some([10, 8, 0, 2].into())
                )[0],
                wifi
            );
        }
    }

    #[test]
    fn offline_route_fallback_keeps_wifi_ahead_of_virtual_adapters() {
        let wifi = Ipv4Addr::new(192, 168, 1, 5);
        assert_eq!(
            order_addresses(
                vec![
                    interface("docker0", [172, 17, 0, 1], false),
                    interface("Wi-Fi", wifi.octets(), false),
                ],
                None
            ),
            vec![wifi, Ipv4Addr::new(172, 17, 0, 1)]
        );
    }

    #[test]
    fn rejects_unusable_addresses_and_deduplicates() {
        let mut down = interface("Ethernet", [10, 0, 0, 8], false);
        down.oper_status = IfOperStatus::Down;
        assert_eq!(
            order_addresses(
                vec![
                    down,
                    interface("Loopback", [127, 0, 0, 1], false),
                    interface("link-local", [169, 254, 1, 1], false),
                    interface("public", [8, 8, 8, 8], false),
                    interface("Tailscale", [100, 101, 9, 106], true),
                    interface("WLAN", [192, 168, 1, 5], false),
                    interface("WLAN duplicate", [192, 168, 1, 5], false),
                ],
                Some([8, 8, 8, 8].into())
            ),
            vec![Ipv4Addr::new(192, 168, 1, 5)]
        );
        assert!(order_addresses(Vec::new(), None).is_empty());
    }
}
