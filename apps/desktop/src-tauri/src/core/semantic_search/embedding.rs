use std::cmp::Ordering;
use std::collections::BinaryHeap;

pub(super) const DIMENSIONS: usize = 768;
const BYTES: usize = DIMENSIONS * std::mem::size_of::<f32>();

pub(super) struct Embedding(Vec<f32>);

impl Embedding {
    pub(super) fn normalize(mut values: Vec<f32>) -> Option<Self> {
        let squared = squared_norm(&values)?;
        if squared == 0.0 {
            return None;
        }
        let length = squared.sqrt();
        for value in &mut values {
            *value = (f64::from(*value) / length) as f32;
        }
        Some(Self(values))
    }

    pub(super) fn from_bytes(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != BYTES {
            return None;
        }
        let values = bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
            .collect::<Vec<_>>();
        // A byte-identical but damaged cache row is not a current embedding.
        if (squared_norm(&values)? - 1.0).abs() > 0.001 {
            return None;
        }
        Some(Self(values))
    }

    pub(super) fn to_bytes(&self) -> Vec<u8> {
        self.0
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }

    pub(super) fn similarity(&self, other: &Self) -> f32 {
        self.0
            .iter()
            .zip(&other.0)
            .map(|(&left, &right)| left * right)
            .sum::<f32>()
            .clamp(-1.0, 1.0)
    }
}

fn squared_norm(values: &[f32]) -> Option<f64> {
    if values.len() != DIMENSIONS || values.iter().any(|value| !value.is_finite()) {
        return None;
    }
    Some(values.iter().map(|&value| f64::from(value).powi(2)).sum())
}

#[derive(Debug)]
pub(super) struct RankedImage {
    pub(super) id: String,
    pub(super) score: f32,
    pub(super) content_sha256: String,
}

impl Ord for RankedImage {
    fn cmp(&self, other: &Self) -> Ordering {
        // The worst retained result is the max heap head.
        other
            .score
            .total_cmp(&self.score)
            .then_with(|| self.id.cmp(&other.id))
    }
}

impl PartialOrd for RankedImage {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for RankedImage {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other).is_eq()
    }
}

impl Eq for RankedImage {}

pub(super) struct TopImages {
    limit: usize,
    heap: BinaryHeap<RankedImage>,
}

impl TopImages {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            limit,
            heap: BinaryHeap::with_capacity(limit),
        }
    }

    pub(super) fn insert(&mut self, ranked: RankedImage) {
        if self.heap.len() < self.limit {
            self.heap.push(ranked);
        } else if let Some(mut worst) = self.heap.peek_mut() {
            if ranked < *worst {
                *worst = ranked;
            }
        }
    }

    pub(super) fn finish(self) -> Vec<RankedImage> {
        self.heap.into_sorted_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_and_storage_reject_invalid_vectors() {
        assert!(Embedding::normalize(vec![0.0; DIMENSIONS]).is_none());
        assert!(Embedding::normalize(vec![f32::NAN; DIMENSIONS]).is_none());
        assert!(Embedding::normalize(vec![f32::INFINITY; DIMENSIONS]).is_none());
        assert!(Embedding::normalize(vec![1.0; DIMENSIONS - 1]).is_none());
        assert!(Embedding::from_bytes(&[0; BYTES]).is_none());
        let unit = Embedding::normalize(vec![f32::MAX; DIMENSIONS]).unwrap();
        let restored = Embedding::from_bytes(&unit.to_bytes()).unwrap();
        assert!((unit.similarity(&restored) - 1.0).abs() < 0.0001);
    }

    #[test]
    fn bounded_ranking_is_similarity_first_then_id() {
        let mut images = TopImages::new(3);
        for (id, score) in [
            ("c", 0.4),
            ("b", 0.4),
            ("unrelated", -0.4),
            ("best", 0.8),
            ("a", 0.4),
        ] {
            images.insert(RankedImage {
                id: id.into(),
                score,
                content_sha256: String::new(),
            });
        }
        let ids = images
            .finish()
            .into_iter()
            .map(|image| image.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, ["best", "a", "b"]);
    }
}
