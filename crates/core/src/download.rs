//! Download sicuro: file temporaneo `.part`, controllo di dimensione e (se noto) SHA-256,
//! poi rename atomico. Un download interrotto o corrotto non lascia mai un file "valido" a metà.

use crate::error::{Error, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Downloaded {
    pub bytes: u64,
    pub sha256: String,
}

fn allowed(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost")
}

/// Scarica `url` in `dest`. `max_bytes` protegge da risposte enormi. `on_progress(scaricati, totale)`.
pub async fn download_to(
    url: &str,
    dest: &Path,
    expected_sha256: Option<&str>,
    max_bytes: u64,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> Result<Downloaded> {
    if !allowed(url) {
        return Err(Error::Download(format!("refusing non-HTTPS url: {url}")));
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| Error::Download(e.to_string()))?;
    let resp = client.get(url).send().await.map_err(|e| Error::Download(format!("{url}: {e}")))?;
    if !resp.status().is_success() {
        return Err(Error::Download(format!("{url}: HTTP {}", resp.status())));
    }
    let total = resp.content_length();
    if total.is_some_and(|t| t > max_bytes) {
        return Err(Error::Download(format!("{url}: file too large ({} bytes)", total.unwrap())));
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let part = dest.with_extension("part");
    let result = async {
        let mut file = tokio::fs::File::create(&part).await?;
        let (mut hasher, mut n) = (Sha256::new(), 0u64);
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| Error::Download(format!("{url}: {e}")))?;
            n += chunk.len() as u64;
            if n > max_bytes {
                return Err(Error::Download(format!("{url}: exceeded {max_bytes} bytes")));
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
            on_progress(n, total);
        }
        file.flush().await?;
        file.sync_all().await?;
        if let Some(t) = total {
            if t != n {
                return Err(Error::Download(format!("{url}: incomplete ({n} of {t} bytes)")));
            }
        }
        let sha256 = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
        if let Some(exp) = expected_sha256 {
            if !exp.eq_ignore_ascii_case(&sha256) {
                return Err(Error::Download(format!("{url}: checksum mismatch")));
            }
        }
        tokio::fs::rename(&part, dest).await?;
        Ok(Downloaded { bytes: n, sha256 })
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Server HTTP minimale: una risposta e chiusura. `claimed` = Content-Length dichiarato.
    async fn serve(status: &str, claimed: usize, body: Vec<u8>) -> String {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let status = status.to_string();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let _ = s.read(&mut buf).await;
            let head = format!("HTTP/1.1 {status}\r\nContent-Length: {claimed}\r\nConnection: close\r\n\r\n");
            let _ = s.write_all(head.as_bytes()).await;
            let _ = s.write_all(&body).await;
            let _ = s.shutdown().await;
        });
        format!("http://{addr}/f.bin")
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("caissora-dl-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d.join("f.bin")
    }

    const SHA_HELLO: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    #[tokio::test]
    async fn downloads_verifies_and_renames() {
        let dest = tmp("ok");
        let url = serve("200 OK", 5, b"hello".to_vec()).await;
        let mut seen = 0;
        let r = download_to(&url, &dest, Some(SHA_HELLO), 1024, |n, _| seen = n).await.unwrap();
        assert_eq!((r.bytes, seen), (5, 5));
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
        assert!(!dest.with_extension("part").exists());
    }

    #[tokio::test]
    async fn truncated_download_leaves_nothing() {
        let dest = tmp("trunc");
        let url = serve("200 OK", 100, b"short".to_vec()).await;
        assert!(download_to(&url, &dest, None, 1024, |_, _| {}).await.is_err());
        assert!(!dest.exists() && !dest.with_extension("part").exists());
    }

    #[tokio::test]
    async fn checksum_mismatch_is_rejected() {
        let dest = tmp("sha");
        let url = serve("200 OK", 5, b"hello".to_vec()).await;
        let e = download_to(&url, &dest, Some(&"0".repeat(64)), 1024, |_, _| {}).await.unwrap_err();
        assert!(e.to_string().contains("checksum"));
        assert!(!dest.exists());
    }

    #[tokio::test]
    async fn http_error_and_size_limit_and_plain_http_remote() {
        let url = serve("404 Not Found", 0, vec![]).await;
        assert!(download_to(&url, &tmp("404"), None, 1024, |_, _| {}).await.unwrap_err().to_string().contains("404"));
        let url = serve("200 OK", 5, b"hello".to_vec()).await;
        assert!(download_to(&url, &tmp("big"), None, 3, |_, _| {}).await.unwrap_err().to_string().contains("too large"));
        assert!(download_to("http://example.com/x", &tmp("plain"), None, 10, |_, _| {}).await.unwrap_err().to_string().contains("non-HTTPS"));
    }
}
