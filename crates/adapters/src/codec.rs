//! Binary encodings for AgentDeck's stores (plan storage-sqlite, section 2A). The first byte of every blob says how the
//! rest is encoded, so a format can change later without rewriting a table.
//!
//! - `MSGPACK` (2), below 512 bytes: MessagePack with field names, so a struct that gains a field still reads old data.
//! - `MSGPACK_ZSTD` (3), 512 bytes and up: the same, zstd-compressed.
//! - `POSTCARD_LZ4` (10): postcard + lz4, for caches that can be rebuilt. Not for user data: postcard does not keep field
//!   names, so changing a struct makes old cache entries unreadable. A cache is then deleted and rebuilt.
//! - `JSON` (0): plain JSON, read only (the text columns written before the codec existed use it).

use serde::{de::DeserializeOwned, Serialize};

pub const JSON: u8 = 0;
pub const MSGPACK: u8 = 2;
pub const MSGPACK_ZSTD: u8 = 3;
pub const POSTCARD_LZ4: u8 = 10;

/// Values from this size up are compressed. Smaller ones do not shrink enough to pay for the CPU.
pub const ZSTD_FROM: usize = 512;
const ZSTD_LEVEL: i32 = 3;

fn prefixed(code: u8, body: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 1);
    out.push(code);
    out.extend_from_slice(&body);
    out
}

/// Data that lasts: user messages, usage, audit. Field names are kept.
pub fn encode_keep<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let packed = rmp_serde::to_vec_named(value).map_err(|error| error.to_string())?;
    if packed.len() < ZSTD_FROM {
        return Ok(prefixed(MSGPACK, packed));
    }
    let compressed =
        zstd::bulk::compress(&packed, ZSTD_LEVEL).map_err(|error| error.to_string())?;
    Ok(prefixed(MSGPACK_ZSTD, compressed))
}

/// A cache that can be rebuilt from its source: speed first, then size.
pub fn encode_cache<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let packed = postcard::to_allocvec(value).map_err(|error| error.to_string())?;
    Ok(prefixed(
        POSTCARD_LZ4,
        lz4_flex::compress_prepend_size(&packed),
    ))
}

/// Reads any blob this module wrote, and plain JSON.
pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    let (&code, body) = bytes.split_first().ok_or("empty value")?;
    match code {
        JSON => serde_json::from_slice(body).map_err(|error| error.to_string()),
        MSGPACK => rmp_serde::from_slice(body).map_err(|error| error.to_string()),
        MSGPACK_ZSTD => {
            let packed = zstd::decode_all(body).map_err(|error| error.to_string())?;
            rmp_serde::from_slice(&packed).map_err(|error| error.to_string())
        }
        POSTCARD_LZ4 => {
            let packed =
                lz4_flex::decompress_size_prepended(body).map_err(|error| error.to_string())?;
            postcard::from_bytes(&packed).map_err(|error| error.to_string())
        }
        other => Err(format!("unknown value encoding {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Serialize, Deserialize, Debug, PartialEq)]
    struct Note {
        kind: String,
        text: String,
    }

    #[derive(Deserialize, Debug, PartialEq)]
    struct NoteV2 {
        kind: String,
        text: String,
        #[serde(default)]
        pinned: bool,
    }

    fn note(text: &str) -> Note {
        Note {
            kind: "text".into(),
            text: text.into(),
        }
    }

    #[test]
    fn small_values_are_not_compressed() {
        let bytes = encode_keep(&note("hi")).expect("encode");
        assert_eq!(bytes[0], MSGPACK);
        assert_eq!(decode::<Note>(&bytes).expect("decode"), note("hi"));
    }

    #[test]
    fn large_values_are_compressed_and_come_back_whole() {
        let big = note(&"the same words again and again ".repeat(400));
        let bytes = encode_keep(&big).expect("encode");
        assert_eq!(bytes[0], MSGPACK_ZSTD);
        let plain = rmp_serde::to_vec_named(&big).expect("plain");
        assert!(
            bytes.len() * 5 < plain.len(),
            "{} vs {}",
            bytes.len(),
            plain.len()
        );
        assert_eq!(decode::<Note>(&bytes).expect("decode"), big);
    }

    #[test]
    fn a_struct_that_gains_a_field_still_reads_old_data() {
        let old = encode_keep(&note("kept")).expect("encode");
        let read: NoteV2 = decode(&old).expect("decode");
        assert_eq!(read.text, "kept");
        assert!(!read.pinned);
    }

    #[test]
    fn caches_round_trip() {
        let value = vec![note("a"), note("b")];
        let bytes = encode_cache(&value).expect("encode");
        assert_eq!(bytes[0], POSTCARD_LZ4);
        assert_eq!(decode::<Vec<Note>>(&bytes).expect("decode"), value);
    }

    #[test]
    fn plain_json_is_still_read() {
        let mut bytes = vec![JSON];
        bytes.extend_from_slice(br#"{"kind":"text","text":"old"}"#);
        assert_eq!(decode::<Note>(&bytes).expect("decode"), note("old"));
    }

    #[test]
    fn unknown_or_empty_values_are_errors() {
        assert!(decode::<Note>(&[]).is_err());
        assert!(decode::<Note>(&[99, 1, 2]).is_err());
    }
}
