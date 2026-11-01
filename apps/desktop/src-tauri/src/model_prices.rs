//! Public model price catalog used for usage estimates.

use std::time::Duration;

use reqwest::header::ACCEPT;
use serde::{Deserialize, Serialize};

const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";

#[derive(Deserialize)]
struct ModelCatalog {
    #[serde(default)]
    data: Vec<CatalogModel>,
}

#[derive(Deserialize)]
struct CatalogModel {
    id: String,
    #[serde(default)]
    pricing: ModelPricing,
}

#[derive(Default, Deserialize)]
struct ModelPricing {
    prompt: Option<String>,
    completion: Option<String>,
    input_cache_read: Option<String>,
}

/// A provider's price in USD per million tokens. `cacheRead` is absent when the catalog does not publish it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    model: String,
    input: f64,
    output: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_read: Option<f64>,
}

fn per_million(value: Option<&str>) -> Option<f64> {
    value?
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value * 1_000_000.0)
}

#[tauri::command]
pub async fn model_price_catalog() -> Result<Vec<ModelPrice>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("AgentDeck model price catalog")
        .build()
        .map_err(|error| format!("Could not create model price client: {error}"))?;

    let response = client
        .get(OPENROUTER_MODELS_URL)
        .header(ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("Could not fetch model prices: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Model price catalog returned HTTP {status}"));
    }

    let catalog = response
        .json::<ModelCatalog>()
        .await
        .map_err(|error| format!("Could not read model prices: {error}"))?;

    Ok(catalog
        .data
        .into_iter()
        .filter_map(|model| {
            let input = per_million(model.pricing.prompt.as_deref())?;
            let output = per_million(model.pricing.completion.as_deref())?;
            Some(ModelPrice {
                model: model.id,
                input,
                output,
                cache_read: per_million(model.pricing.input_cache_read.as_deref()),
            })
        })
        .collect())
}
