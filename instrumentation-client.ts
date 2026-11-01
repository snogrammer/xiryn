// Runs in the browser before the app starts. Error reporting only starts
// when the server put its settings in the page (SENTRY_DSN is set).
import { startClientReporting } from "@/lib/sentry-client"

void startClientReporting()
