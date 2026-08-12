const GITHUB_DISPATCH_URL =
  "https://api.github.com/repos/seqispotlights/se-qi-spotlights/actions/workflows/publish-spotlights.yml/dispatches";
const GITHUB_REF = "main";
const GITHUB_TOKEN_PROPERTY = "GITHUB_TOKEN";
const TRIGGER_HANDLER = "triggerSpotlightsPublisher";

/** Runs from the five-minute Apps Script time trigger. */
function triggerSpotlightsPublisher() {
  dispatchSpotlightsWorkflow_();
}

/** Runs one dispatch manually to verify authorization and GitHub access. */
function testGitHubTriggerOnce() {
  dispatchSpotlightsWorkflow_();
  return "GitHub accepted the Publish SE-QI Spotlights workflow dispatch.";
}

/** Creates exactly one five-minute trigger for the publisher. */
function setupFiveMinuteTrigger() {
  const matchingTriggers = ScriptApp.getProjectTriggers().filter(
    trigger => trigger.getHandlerFunction() === TRIGGER_HANDLER
  );

  if (matchingTriggers.length === 0) {
    ScriptApp.newTrigger(TRIGGER_HANDLER)
      .timeBased()
      .everyMinutes(5)
      .create();
    return "Created the five-minute SE-QI Spotlights trigger.";
  }

  matchingTriggers.slice(1).forEach(trigger => ScriptApp.deleteTrigger(trigger));
  return "The five-minute SE-QI Spotlights trigger already exists.";
}

function dispatchSpotlightsWorkflow_() {
  const token = PropertiesService.getScriptProperties().getProperty(GITHUB_TOKEN_PROPERTY);
  if (!token || token.trim() === "") {
    throw new Error(
      "Missing GITHUB_TOKEN. Add it under Project Settings > Script Properties."
    );
  }

  const response = UrlFetchApp.fetch(GITHUB_DISPATCH_URL, {
    method: "post",
    contentType: "application/json",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10"
    },
    payload: JSON.stringify({ ref: GITHUB_REF }),
    muteHttpExceptions: true
  });
  const statusCode = response.getResponseCode();

  if (statusCode === 200 || statusCode === 204) return;

  const responseBody = response.getContentText().trim();
  const detail = responseBody ? `: ${responseBody.slice(0, 1000)}` : "";
  throw new Error(`GitHub workflow dispatch failed with HTTP ${statusCode}${detail}`);
}
