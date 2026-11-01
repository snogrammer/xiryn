import type { Metadata, Viewport } from "next"
import localFont from "next/font/local"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/toast"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { sentryOptions } from "@/lib/report"

// Fonts ship with the app (npm, SIL OFL); nothing is fetched from a font CDN
const inter = localFont({
  src: [
    {
      path: "../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
      weight: "100 900",
    },
    {
      path: "../node_modules/@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2",
      weight: "100 900",
    },
  ],
  variable: "--font-inter",
  display: "swap",
})
const mono = localFont({
  src: "../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
  weight: "100 800",
  variable: "--font-jetbrains",
  display: "swap",
})

export const metadata: Metadata = {
  title: { default: "Xiryn", template: "%s · Xiryn" },
  description:
    "Self-hosted AI agents on your own keys: a sandboxed Linux workstation, long-term memory and any model per agent, reachable from Telegram.",
  applicationName: "Xiryn",
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#14151a" },
    { media: "(prefers-color-scheme: light)", color: "#fafbfc" },
  ],
}

// Everything is read from the local database at request time
export const dynamic = "force-dynamic"

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const options = sentryOptions()
  const sentry = options && {
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    tracesSampleRate: options.tracesSampleRate,
  }
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(inter.variable, mono.variable)}
    >
      {/* Browser extensions add attributes to <body> before React loads */}
      <body suppressHydrationWarning>
        {/* Error reporting settings for the browser, only when it's on */}
        {sentry && (
          <script
            id="xiryn-sentry"
            type="application/json"
            dangerouslySetInnerHTML={{
              __html: JSON.stringify(sentry).replace(/</g, "\\u003c"),
            }}
          />
        )}
        <ThemeProvider>
          <TooltipProvider delay={300}>{children}</TooltipProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
