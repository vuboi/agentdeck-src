//! Muse Code's native subscription auth for the OpenAI Responses API.

use reqwest::RequestBuilder;

pub(crate) async fn authorize(request: RequestBuilder) -> Result<RequestBuilder, String> {
    let key = crate::connectors::muse_code::access_token().await?;
    Ok(request
        .bearer_auth(key)
        .header("User-Agent", "AgentDeck/1.0"))
}
