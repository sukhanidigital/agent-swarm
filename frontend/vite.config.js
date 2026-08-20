import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // host: true binds to 0.0.0.0 (all network interfaces) instead of just localhost, so a phone (or
  // any other device) on the same wifi network can reach this dev server via the machine's LAN IP.
  server: { host: true },
})
