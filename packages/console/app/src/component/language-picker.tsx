import { useLanguage } from "~/context/language"
import "./language-picker.css"

export function LanguagePicker(_props: { align?: "left" | "right" } = {}) {
  const language = useLanguage()
  return (
    <div data-component="language-picker">
      <span>{language.label(language.locale())}</span>
    </div>
  )
}
