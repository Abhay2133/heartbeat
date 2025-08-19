// handler.js
// Export a function that will be called with the fetch Response
// You can customize this to do logging, metrics, alerts, etc.

/**
 * Handle the result of a ping request.
 * @param {object} ctx - Context information about the ping.
 * @param {Response|null} response - Fetch response when successful; null if request failed.
 * @param {Error|null} error - Error if request failed; null on success.
 */
async function handlePing(ctx, response, error) {
  const {
    GCP_PROJECT_ID,
    GOOGLE_CLOUD_PROJECT,
    GCLOUD_PROJECT,
    GCP_ZONE,
    GCP_INSTANCE_NAME,
    GCP_RESTART_STRATEGY = 'start', // 'start' or 'reset'
    RESTART_COOLDOWN_SECONDS = '300', // 5 minutes default
  } = process.env;

  const projectId = GCP_PROJECT_ID || GOOGLE_CLOUD_PROJECT || GCLOUD_PROJECT;
  const zone = GCP_ZONE;
  const instance = GCP_INSTANCE_NAME;
  const cooldownMs = Math.max(0, Number(RESTART_COOLDOWN_SECONDS) || 0) * 1000;

  const startedAt = ctx?.startedAt || Date.now();
  const endedAt = ctx?.endedAt || Date.now();
  const latencyMs = endedAt - startedAt;

  // Simple logger prefix
  const logPrefix = `[heartbeat]`;

  if (response && response.ok) {
    console.log(`${logPrefix} Ping OK ${ctx?.url || ''} - status=${response.status} latency=${latencyMs}ms`);
    return;
  }

  const statusInfo = response ? `status=${response.status}` : `error=${error?.message || 'unknown'}`;
  console.warn(`${logPrefix} Ping FAILED ${ctx?.url || ''} - ${statusInfo} latency=${latencyMs}ms`);

  // Guard: only attempt restart if we have the required env config
  if (!projectId || !zone || !instance) {
    console.warn(`${logPrefix} Missing GCP env vars. Required: GCP_PROJECT_ID (or GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT), GCP_ZONE, GCP_INSTANCE_NAME. Skipping restart.`);
    return;
  }

  // Cooldown to avoid thrashing
  if (!global.__heartbeatLastRestartAt) global.__heartbeatLastRestartAt = 0;
  const now = Date.now();
  if (cooldownMs > 0 && now - global.__heartbeatLastRestartAt < cooldownMs) {
    const waitMs = cooldownMs - (now - global.__heartbeatLastRestartAt);
    console.warn(`${logPrefix} Restart skipped due to cooldown (${Math.ceil(waitMs / 1000)}s remaining).`);
    return;
  }

  try {
    await restartComputeInstance({ projectId, zone, instance, strategy: GCP_RESTART_STRATEGY });
    global.__heartbeatLastRestartAt = Date.now();
    console.log(`${logPrefix} Restart triggered for instance ${instance} in ${zone} (project ${projectId}).`);
  } catch (e) {
    console.error(`${logPrefix} Failed to trigger restart for ${instance}:`, e?.message || e);
  }

}

module.exports = { handlePing };

// --- Helpers ---
async function restartComputeInstance({ projectId, zone, instance, strategy = 'start' }) {
  // Uses Google Auth Library to acquire an access token and call the Compute Engine REST API.
  // Requires ADC to be available (e.g., GOOGLE_APPLICATION_CREDENTIALS pointing to a service account JSON,
  // or running in an environment with default credentials).
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();

  const base = `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(projectId)}/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(instance)}`;
  const action = strategy === 'reset' ? 'reset' : 'start';
  const url = `${base}/${action}`;

  // Fire the action. If the instance is already running, 'start' may return an error; treat as non-fatal.
  try {
    await client.request({ url, method: 'POST' });
  } catch (err) {
    const msg = err?.message || String(err);
    // If already running, ignore; otherwise, rethrow.
    const alreadyRunningHints = ['already in state RUNNING', 'is starting', 'operationInProgress'];
    if (!alreadyRunningHints.some((h) => msg.includes(h))) {
      throw err;
    }
  }
}
