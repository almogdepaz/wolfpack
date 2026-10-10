//! Standard (RFC 4648) base64 encoding with `=` padding, for binary payloads
//! carried in JSON control responses.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).copied().map_or(0, u32::from);
        let b2 = chunk.get(2).copied().map_or(0, u32::from);
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(char::from(ALPHABET[(triple >> 18) as usize & 63]));
        out.push(char::from(ALPHABET[(triple >> 12) as usize & 63]));
        out.push(if chunk.len() > 1 { char::from(ALPHABET[(triple >> 6) as usize & 63]) } else { '=' });
        out.push(if chunk.len() > 2 { char::from(ALPHABET[triple as usize & 63]) } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encoded length of `len` input bytes.
    fn encoded_len(len: usize) -> usize {
        len.div_ceil(3) * 4
    }

    #[test]
    fn encodes_rfc4648_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(encode(input.as_bytes()), expected);
            assert_eq!(encoded_len(input.len()), expected.len());
        }
    }

    #[test]
    fn encodes_every_byte_value() {
        let bytes: Vec<u8> = (0..=255).collect();
        let encoded = encode(&bytes);
        assert!(encoded.starts_with("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v"));
        assert!(encoded.ends_with("+/w=="));
        assert_eq!(encoded.len(), encoded_len(bytes.len()));
    }
}
