import { getApiUrl, getApiKey } from "./config";

// Every call reads the URL/key fresh (not a module-load-time constant) so the Settings screen can
// change them without a page reload, and attaches X-API-Key whenever one's configured — a no-op
// against a backend that hasn't set API_KEY (see api/auth.py), required against one that has.
async function apiFetch(path, options = {}) {
  const key = getApiKey();
  const headers = { ...(options.headers || {}) };
  if (key) headers["X-API-Key"] = key;
  return fetch(`${getApiUrl()}${path}`, { ...options, headers });
}

function jsonFetch(path, body) {
  return apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function login({ email, password }) {
  const res = await jsonFetch("/login", { email, password });
  if (!res.ok) throw new Error(`Couldn't log in: ${await res.text()}`);
  return res.json(); // { api_key }
}

export async function getModelConfig() {
  const res = await apiFetch("/models");
  if (!res.ok) throw new Error(`Couldn't fetch model config: ${await res.text()}`);
  return res.json(); // { providers, default_models, claude_models, openai_models }
}

export async function planProject({ prompt, repoPath, instructions, model }) {
  const res = await jsonFetch("/plan", { prompt, repo_path: repoPath, instructions: instructions || "", model });
  if (!res.ok) throw new Error(`Couldn't plan: ${await res.text()}`);
  const data = await res.json();
  return data.trees; // [{summary, subtasks: [{task, acceptance}], num_devs}]
}

export async function submitJob({ prompt, repoPath, plan, maxCost, blockInstructions, gateCaps, models }) {
  const res = await jsonFetch("/jobs", {
    prompt, repo_path: repoPath, plan,
    max_cost: maxCost, block_instructions: blockInstructions, gate_caps: gateCaps, models,
  });
  if (!res.ok) throw new Error(`Couldn't start: ${await res.text()}`);
  return res.json(); // { job_id }
}

export async function getJob(jobId) {
  const res = await apiFetch(`/jobs/${jobId}`);
  if (!res.ok) throw new Error(`Couldn't fetch job: ${await res.text()}`);
  return res.json();
}

export async function stopJob(jobId) {
  const res = await apiFetch(`/jobs/${jobId}/stop`, { method: "POST" });
  if (!res.ok) throw new Error(`Couldn't stop job: ${await res.text()}`);
  return res.json();
}

export async function resumeJob(jobId, instructions) {
  const res = await jsonFetch(`/jobs/${jobId}/resume`, { instructions });
  if (!res.ok) throw new Error(`Couldn't resume job: ${await res.text()}`);
  return res.json();
}

export async function createRepo({ path, github }) {
  const res = await jsonFetch("/repos", { path, github: !!github });
  if (!res.ok) throw new Error(`Couldn't create repo: ${await res.text()}`);
  return res.json(); // { path }
}

export async function listProjects() {
  const res = await apiFetch("/projects");
  if (!res.ok) throw new Error(`Couldn't list projects: ${await res.text()}`);
  return res.json(); // [{ id, name, path, created_at }]
}

export async function createProject(name) {
  const res = await jsonFetch("/projects", { name });
  if (!res.ok) throw new Error(`Couldn't create project: ${await res.text()}`);
  return res.json(); // { id, name, path, created_at }
}

export async function startChat({ repoPath }) {
  const res = await jsonFetch("/chat/start", { repo_path: repoPath });
  if (!res.ok) throw new Error(`Couldn't start chat: ${await res.text()}`);
  return res.json(); // { chat_id }
}

export async function sendChatMessage(chatId, message) {
  const res = await jsonFetch(`/chat/${chatId}/message`, { message });
  if (!res.ok) throw new Error(`Couldn't send message: ${await res.text()}`);
  return res.json(); // { reply }
}

export async function startRun(jobId) {
  const res = await apiFetch(`/jobs/${jobId}/run`, { method: "POST" });
  if (!res.ok) throw new Error(`Couldn't start run: ${await res.text()}`);
  return res.json(); // { services: [...] }
}

export async function getRunStatus(jobId) {
  const res = await apiFetch(`/jobs/${jobId}/run`);
  if (!res.ok) throw new Error(`Couldn't fetch run status: ${await res.text()}`);
  return res.json();
}

export async function stopRun(jobId) {
  const res = await apiFetch(`/jobs/${jobId}/run/stop`, { method: "POST" });
  if (!res.ok) throw new Error(`Couldn't stop run: ${await res.text()}`);
  return res.json();
}

export async function startPathRun(path) {
  const res = await jsonFetch("/run", { path });
  if (!res.ok) throw new Error(`Couldn't start run: ${await res.text()}`);
  return res.json(); // { run_id, services: [...] }
}

export async function getPathRunStatus(runId) {
  const res = await apiFetch(`/run/${runId}`);
  if (!res.ok) throw new Error(`Couldn't fetch run status: ${await res.text()}`);
  return res.json();
}

export async function stopPathRun(runId) {
  const res = await apiFetch(`/run/${runId}/stop`, { method: "POST" });
  if (!res.ok) throw new Error(`Couldn't stop run: ${await res.text()}`);
  return res.json();
}
