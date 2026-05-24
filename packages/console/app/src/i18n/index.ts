import type { Locale } from "~/lib/language"
import { dict as en } from "~/i18n/en"

export type Key = keyof typeof en
export type Dict = Record<Key, string>

const base = en satisfies Dict

export function i18n(_locale: Locale): Dict {
  return base
}
