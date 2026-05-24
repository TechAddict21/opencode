import { Router } from "@solidjs/router"
import { FileRoutes } from "@solidjs/start/router"
import { Font } from "@nous-ai/ui/font"
import { MetaProvider } from "@solidjs/meta"
import { MarkedProvider } from "@nous-ai/ui/context/marked"
import { DialogProvider } from "@nous-ai/ui/context/dialog"
import { I18nProvider, type UiI18nParams } from "@nous-ai/ui/context"
import { dict as uiEn } from "@nous-ai/ui/i18n/en"
import { createMemo, Suspense, type ParentProps } from "solid-js"
import "./app.css"
import { Favicon } from "@nous-ai/ui/favicon"

function resolveTemplate(text: string, params?: UiI18nParams) {
  if (!params) return text
  return text.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey) => {
    const key = String(rawKey)
    const value = params[key]
    return value === undefined ? "" : String(value)
  })
}

function UiI18nBridge(props: ParentProps) {
  const locale = createMemo(() => "en")
  const t = (key: keyof typeof uiEn, params?: UiI18nParams) => {
    const value = uiEn[key]
    const text = value ?? String(key)
    return resolveTemplate(text, params)
  }

  return <I18nProvider value={{ locale, t }}>{props.children}</I18nProvider>
}

export default function App() {
  return (
    <Router
      root={(props) => (
        <MetaProvider>
          <DialogProvider>
            <MarkedProvider>
              <Favicon />
              <Font />
              <UiI18nBridge>
                <Suspense>{props.children}</Suspense>
              </UiI18nBridge>
            </MarkedProvider>
          </DialogProvider>
        </MetaProvider>
      )}
    >
      <FileRoutes />
    </Router>
  )
}
