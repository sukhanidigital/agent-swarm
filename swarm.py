"""Convenience entry point: `python swarm.py` starts the FastAPI backend (port 8000, job engine +
REST API). The UI is now the React app in frontend/ — run it separately with `npm run dev` (see
README) and open the Vite dev server URL it prints (typically http://localhost:5173).

Restart manually after code changes (Ctrl+C, then rerun) — uvicorn's reload=False here on purpose.
Its --reload uses multiprocessing to spawn the worker, and on this machine's conda-based venv that
child resolves to the base miniconda interpreter instead of the venv (a Windows/conda rough edge),
silently running a different Python than the one everything was pip installed into. Not worth
fighting for a local dev tool."""
import uvicorn

if __name__ == "__main__":
    uvicorn.run("api.main:app", host="0.0.0.0", port=8000, reload=False)
