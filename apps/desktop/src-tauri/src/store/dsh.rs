//! DeepSeek Harness plugin management for the shared MCP Store.
//!
//! DSH owns profile composition and package compatibility. AgentDeck only reads the profile manifest and delegates
//! add/remove to the official `dsh plugin` command, so external DSH bundles keep their native format and lifecycle.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::connectors::{capture, failure, which};

const PROFILE: &str = "sdk";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PluginItem {
    pub id: String,
    pub name: String,
    pub version: String,
    pub source: String,
    pub enabled: bool,
    pub profile: String,
}

fn dsh_home() -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("DSH_HOME") {
        return Ok(PathBuf::from(home));
    }
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| PathBuf::from(home).join(".dsh"))
        .ok_or_else(|| "could not resolve the user home for DSH_HOME".to_owned())
}

fn profile_dir() -> Result<PathBuf, String> {
    Ok(dsh_home()?.join("profiles").join(PROFILE))
}

fn package_name(row: &Value) -> Option<&str> {
    row.as_str()
        .or_else(|| row.get("name").and_then(Value::as_str))
}

fn dependency_items(package: &Value) -> impl Iterator<Item = (&str, &Value)> {
    ["dependencies", "devDependencies", "optionalDependencies"]
        .into_iter()
        .filter_map(|key| package.get(key).and_then(Value::as_object))
        .flat_map(|deps| deps.iter())
}

pub fn installed() -> Result<Vec<PluginItem>, String> {
    let profile = profile_dir()?;
    let package_path = profile.join("package.json");
    let manifest = std::fs::read_to_string(&package_path)
        .map_err(|error| format!("DSH sdk profile is unavailable: {error}"))?;
    let package: Value = serde_json::from_str(&manifest).map_err(|error| error.to_string())?;
    let enabled = package["dsh"]["profile"]["bundles"]
        .as_array()
        .map(|bundles| {
            bundles
                .iter()
                .filter_map(package_name)
                .collect::<std::collections::BTreeSet<_>>()
        })
        .unwrap_or_default();
    Ok(dependency_items(&package)
        .filter_map(|(name, version)| {
            if name.starts_with("@deepseek-ai/dsh-") && name != "@deepseek-ai/dsh-base" {
                // Shipped DSH application bundles are runtime infrastructure, not external plugins.
                return None;
            }
            Some(PluginItem {
                id: name.to_owned(),
                name: name.to_owned(),
                version: version.as_str().unwrap_or_default().to_owned(),
                source: version.as_str().unwrap_or_default().to_owned(),
                enabled: enabled.contains(name),
                profile: PROFILE.to_owned(),
            })
        })
        .collect())
}

fn check_spec(spec: &str) -> Result<(), String> {
    let spec = spec.trim();
    if spec.is_empty() || spec.starts_with('-') || spec.chars().any(char::is_whitespace) {
        return Err("invalid DSH plugin spec".to_owned());
    }
    Ok(())
}

async fn run(args: &[&str]) -> Result<String, String> {
    let program =
        which("dsh").ok_or_else(|| "dsh CLI is not installed or not on PATH".to_owned())?;
    let output = capture(&program, args, Duration::from_secs(300)).await?;
    if output.ok {
        Ok(output.stdout)
    } else {
        Err(failure(&output))
    }
}

pub async fn add(spec: String) -> Result<(), String> {
    check_spec(&spec)?;
    run(&["plugin", "--profile", PROFILE, "add", &spec])
        .await
        .map(|_| ())
}

pub async fn remove(name: String) -> Result<(), String> {
    check_spec(&name)?;
    run(&["plugin", "--profile", PROFILE, "remove", &name])
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::{check_spec, dependency_items};
    use serde_json::json;

    #[test]
    fn accepts_registry_git_and_local_specs_without_shell_expansion() {
        for spec in [
            "@deepseek-ai/dsh-skill-office@latest",
            "https://github.com/acme/dsh-plugin.git",
            "file:../dsh-plugin",
        ] {
            assert!(check_spec(spec).is_ok(), "{spec}");
        }
        assert!(check_spec("--ignore-scripts").is_err());
        assert!(check_spec("plugin with spaces").is_err());
    }

    #[test]
    fn reads_all_package_dependency_sections() {
        let package = json!({
            "dependencies": {"a": "1"},
            "devDependencies": {"b": "2"},
            "optionalDependencies": {"c": "3"}
        });
        let names: Vec<&str> = dependency_items(&package).map(|(name, _)| name).collect();
        assert_eq!(names, vec!["a", "b", "c"]);
    }
}
