// Resolves off whatever host actually loaded this page, not a hardcoded "localhost" — that only ever
// meant "this machine" when the page was loaded from the same machine running the backend. Opened
// from a phone on the LAN (or eventually a real domain), "localhost" would mean the phone itself and
// every request would silently fail against nothing.
const API = `${window.location.protocol}//${window.location.hostname}:8000`;

export async function getModelConfig() {
  const res = await fetch(`${API}/models`);
  if (!res.ok) throw new Error(`Couldn't fetch model config: ${await res.text()}`);
  return res.json(); // { providers, default_models, claude_models, openai_models, pricing }
}

export async function checkPath(path) {
  const res = await fetch(`${API}/check-path?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Couldn't check path: ${await res.text()}`);
  return res.json(); // { exists, is_dir, is_git_repo, is_absolute }
}

export async function planProject({ prompt, repoPath, instructions, model }) {
  const res = await fetch(`${API}/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, repo_path: repoPath, instructions: instructions || "", model }),
  });
  if (!res.ok) throw new Error(`Couldn't plan: ${await res.text()}`);
  // Full response now, not just trees: each tree also carries a suggested complexity/models/caps/
  // instructions, plus top-level auditor_model/auditor_cap/auditor_instructions — all editable
  // starting points the caller pre-fills the UI with, not binding decisions.
  return res.json();
}

export async function submitJob({ prompt, repoPath, plan, maxCost, blockInstructions, gateCaps, models }) {
  const res = await fetch(`${API}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt, repo_path: repoPath, plan,
      max_cost: maxCost, block_instructions: blockInstructions, gate_caps: gateCaps, models,
    }),
  });
  if (!res.ok) throw new Error(`Couldn't start: ${await res.text()}`);
  return res.json(); // { job_id }
}

export async function getJob(jobId) {
  const res = await fetch(`${API}/jobs/${jobId}`);
  if (!res.ok) throw new Error(`Couldn't fetch job: ${await res.text()}`);
  return res.json();
}

export async function stopJob(jobId) {
  const res = await fetch(`${API}/jobs/${jobId}/stop`, { method: "POST" });
  if (!res.ok) throw new Error(`Couldn't stop job: ${await res.text()}`);
  return res.json();
}

export async function resumeJob(jobId, instructions) {
  const res = await fetch(`${API}/jobs/${jobId}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instructions }),
  });
  if (!res.ok) throw new Error(`Couldn't resume job: ${await res.text()}`);
  return res.json();
}

export async function createRepo({ path, github }) {
  const res = await fetch(`${API}/repos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, github: !!github }),
  });
  if (!res.ok) throw new Error(`Couldn't create repo: ${await res.text()}`);
  return res.json(); // { path }
}

export async function startChat({ repoPath }) {
  const res = await fetch(`${API}/chat/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo_path: repoPath }),
  });
  if (!res.ok) throw new Error(`Couldn't start chat: ${await res.text()}`);
  return res.json(); // { chat_id }
}

export async function sendChatMessage(chatId, message) {
  const res = await fetch(`${API}/chat/${chatId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Couldn't send message: ${await res.text()}`);
  return res.json(); // { reply }
}

export async function startRun(jobId) {
  const res = await fetch(`${API}/jobs/${jobId}/run`, { method: "POST" });
  if (!res.ok) throw new Error(`Couldn't start run: ${await res.text()}`);
  return res.json(); // { services: [...] }
}

export async function getRunStatus(jobId) {
  const res = await fetch(`${API}/jobs/${jobId}/run`);
  if (!res.ok) throw new Error(`Couldn't fetch run status: ${await res.text()}`);
  return res.json();
}

export async function stopRun(jobId) {
  const res = await fetch(`${API}/jobs/${jobId}/run/stop`, { method: "POST" });
  if (!res.ok) throw new Error(`Couldn't stop run: ${await res.text()}`);
  return res.json();
}

export async function startPathRun(path) {
  const res = await fetch(`${API}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`Couldn't start run: ${await res.text()}`);
  return res.json(); // { run_id, services: [...] }
}

export async function getPathRunStatus(runId) {
  const res = await fetch(`${API}/run/${runId}`);
  if (!res.ok) throw new Error(`Couldn't fetch run status: ${await res.text()}`);
  return res.json();
}

export async function stopPathRun(runId) {
  const res = await fetch(`${API}/run/${runId}/stop`, { method: "POST" });
  if (!res.ok) throw new Error(`Couldn't stop run: ${await res.text()}`);
  return res.json();
}
