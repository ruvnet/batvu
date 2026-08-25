//! A tiny dependency-free JSON codec.
//!
//! Same rationale as `@metaharness/horizon`'s core: the wasm module must be
//! self-contained and free of `wasm-bindgen`, so it carries its own codec for
//! the control ABI. This is deliberately minimal — the hot path never touches
//! JSON (see `abi::bv_plan_process`, which moves raw `f32` across the boundary).

use std::collections::BTreeMap;
use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(BTreeMap<String, Value>),
}

impl Value {
    pub fn get(&self, k: &str) -> Option<&Value> {
        match self {
            Value::Obj(o) => o.get(k),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Num(n) => Some(*n),
            _ => None,
        }
    }
    pub fn as_f32(&self) -> Option<f32> {
        self.as_f64().map(|v| v as f32)
    }
    pub fn as_usize(&self) -> Option<usize> {
        self.as_f64().and_then(|v| {
            if v >= 0.0 && v.is_finite() {
                Some(v as usize)
            } else {
                None
            }
        })
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }
    pub fn as_arr(&self) -> Option<&[Value]> {
        match self {
            Value::Arr(a) => Some(a),
            _ => None,
        }
    }

    /// Field lookup with a default, so callers can be partially specified.
    pub fn f32_or(&self, k: &str, d: f32) -> f32 {
        self.get(k).and_then(|v| v.as_f32()).unwrap_or(d)
    }
    pub fn usize_or(&self, k: &str, d: usize) -> usize {
        self.get(k).and_then(|v| v.as_usize()).unwrap_or(d)
    }
    pub fn bool_or(&self, k: &str, d: bool) -> bool {
        self.get(k).and_then(|v| v.as_bool()).unwrap_or(d)
    }
    pub fn str_or<'a>(&'a self, k: &str, d: &'a str) -> &'a str {
        self.get(k).and_then(|v| v.as_str()).unwrap_or(d)
    }

    pub fn obj(pairs: Vec<(&str, Value)>) -> Value {
        let mut m = BTreeMap::new();
        for (k, v) in pairs {
            m.insert(k.to_string(), v);
        }
        Value::Obj(m)
    }
    pub fn num(v: f64) -> Value {
        Value::Num(if v.is_finite() { v } else { 0.0 })
    }
    pub fn str(v: &str) -> Value {
        Value::Str(v.to_string())
    }
    pub fn f32_arr(v: &[f32]) -> Value {
        Value::Arr(v.iter().map(|x| Value::num(*x as f64)).collect())
    }
}

// ─────────────────────────────────────────────────────────────── serialize ──

pub fn to_string(v: &Value) -> String {
    let mut s = String::new();
    write_value(&mut s, v);
    s
}

fn write_value(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Num(n) => {
            if n.is_finite() {
                // Trim the trailing ".0" that Rust's Display adds to integral f64s.
                let _ = write!(out, "{}", n);
            } else {
                out.push_str("null");
            }
        }
        Value::Str(s) => write_string(out, s),
        Value::Arr(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, x);
            }
            out.push(']');
        }
        Value::Obj(o) => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, k);
                out.push(':');
                write_value(out, x);
            }
            out.push('}');
        }
    }
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

// ───────────────────────────────────────────────────────────────── parse ──

pub fn parse(src: &str) -> Result<Value, String> {
    let b = src.as_bytes();
    let mut i = 0usize;
    let v = parse_value(b, &mut i)?;
    skip_ws(b, &mut i);
    if i != b.len() {
        return Err(format!("trailing input at byte {}", i));
    }
    Ok(v)
}

fn skip_ws(b: &[u8], i: &mut usize) {
    while *i < b.len() && matches!(b[*i], b' ' | b'\t' | b'\n' | b'\r') {
        *i += 1;
    }
}

fn parse_value(b: &[u8], i: &mut usize) -> Result<Value, String> {
    skip_ws(b, i);
    match b.get(*i) {
        None => Err("unexpected end of input".into()),
        Some(b'n') => lit(b, i, "null", Value::Null),
        Some(b't') => lit(b, i, "true", Value::Bool(true)),
        Some(b'f') => lit(b, i, "false", Value::Bool(false)),
        Some(b'"') => parse_str(b, i).map(Value::Str),
        Some(b'[') => {
            *i += 1;
            let mut out = Vec::new();
            skip_ws(b, i);
            if b.get(*i) == Some(&b']') {
                *i += 1;
                return Ok(Value::Arr(out));
            }
            loop {
                out.push(parse_value(b, i)?);
                skip_ws(b, i);
                match b.get(*i) {
                    Some(b',') => *i += 1,
                    Some(b']') => {
                        *i += 1;
                        return Ok(Value::Arr(out));
                    }
                    _ => return Err(format!("expected ',' or ']' at byte {}", i)),
                }
            }
        }
        Some(b'{') => {
            *i += 1;
            let mut m = BTreeMap::new();
            skip_ws(b, i);
            if b.get(*i) == Some(&b'}') {
                *i += 1;
                return Ok(Value::Obj(m));
            }
            loop {
                skip_ws(b, i);
                let k = parse_str(b, i)?;
                skip_ws(b, i);
                if b.get(*i) != Some(&b':') {
                    return Err(format!("expected ':' at byte {}", i));
                }
                *i += 1;
                let v = parse_value(b, i)?;
                m.insert(k, v);
                skip_ws(b, i);
                match b.get(*i) {
                    Some(b',') => *i += 1,
                    Some(b'}') => {
                        *i += 1;
                        return Ok(Value::Obj(m));
                    }
                    _ => return Err(format!("expected ',' or '}}' at byte {}", i)),
                }
            }
        }
        Some(_) => parse_num(b, i),
    }
}

fn lit(b: &[u8], i: &mut usize, word: &str, v: Value) -> Result<Value, String> {
    if b.len() >= *i + word.len() && &b[*i..*i + word.len()] == word.as_bytes() {
        *i += word.len();
        Ok(v)
    } else {
        Err(format!("bad literal at byte {}", i))
    }
}

fn parse_str(b: &[u8], i: &mut usize) -> Result<String, String> {
    if b.get(*i) != Some(&b'"') {
        return Err(format!("expected string at byte {}", i));
    }
    *i += 1;
    let mut out = String::new();
    while let Some(&c) = b.get(*i) {
        *i += 1;
        match c {
            b'"' => return Ok(out),
            b'\\' => {
                let e = *b.get(*i).ok_or("unterminated escape")?;
                *i += 1;
                match e {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'b' => out.push('\u{8}'),
                    b'f' => out.push('\u{c}'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let hex = b.get(*i..*i + 4).ok_or("truncated \\u escape")?;
                        let cp = u32::from_str_radix(
                            std::str::from_utf8(hex).map_err(|_| "bad \\u escape")?,
                            16,
                        )
                        .map_err(|_| "bad \\u escape")?;
                        *i += 4;
                        out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                    }
                    _ => return Err("bad escape".into()),
                }
            }
            c => {
                // Re-decode the UTF-8 sequence starting at this byte.
                let start = *i - 1;
                let len = utf8_len(c);
                let end = start + len;
                let s = std::str::from_utf8(b.get(start..end).ok_or("bad utf8")?)
                    .map_err(|_| "bad utf8")?;
                out.push_str(s);
                *i = end;
            }
        }
    }
    Err("unterminated string".into())
}

fn utf8_len(first: u8) -> usize {
    match first {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    }
}

fn parse_num(b: &[u8], i: &mut usize) -> Result<Value, String> {
    let start = *i;
    if b.get(*i) == Some(&b'-') || b.get(*i) == Some(&b'+') {
        *i += 1;
    }
    while let Some(&c) = b.get(*i) {
        if c.is_ascii_digit() || c == b'.' || c == b'e' || c == b'E' || c == b'-' || c == b'+' {
            *i += 1;
        } else {
            break;
        }
    }
    std::str::from_utf8(&b[start..*i])
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .map(Value::Num)
        .ok_or_else(|| format!("bad number at byte {}", start))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_nested_documents() {
        let src = r#"{"a":[1,2.5,-3e2],"b":{"c":"x\"y","d":true},"e":null}"#;
        let v = parse(src).expect("parse");
        let out = to_string(&v);
        let v2 = parse(&out).expect("reparse");
        assert_eq!(v, v2);
        assert_eq!(v.get("b").unwrap().get("d").unwrap().as_bool(), Some(true));
        assert_eq!(v.get("a").unwrap().as_arr().unwrap().len(), 3);
    }

    #[test]
    fn defaults_apply_to_missing_fields() {
        let v = parse(r#"{"fs":48000}"#).unwrap();
        assert_eq!(v.f32_or("fs", 1.0), 48000.0);
        assert_eq!(v.f32_or("missing", 7.5), 7.5);
        assert_eq!(v.str_or("window", "hann"), "hann");
    }

    #[test]
    fn rejects_malformed_input() {
        assert!(parse("{").is_err());
        assert!(parse("[1,]").is_err());
        assert!(parse("nul").is_err());
        assert!(parse(r#"{"a":1}{"#).is_err());
    }

    #[test]
    fn escapes_survive_a_round_trip() {
        let v = Value::str("tab\there \"quoted\" \u{1f987}");
        let s = to_string(&v);
        assert_eq!(parse(&s).unwrap(), v);
    }
}
