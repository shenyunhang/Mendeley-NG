import { createContext, useContext, type ReactNode } from 'react'
import {
  DEFAULT_LANGUAGE,
  makeTranslator,
  type Translator
} from './i18n'

/**
 * The translator is a context value rather than a prop so a language change
 * reaches a memoised child without threading a new argument through every
 * component in between. `useContext` re-renders consumers even when their
 * own props did not change, which is exactly what a language switch needs.
 *
 * App builds the translator itself and hands it down, so the root component
 * can use the very same one without sitting below its own provider.
 */
const I18nContext = createContext<Translator>(makeTranslator(DEFAULT_LANGUAGE))

export function I18nProvider({
  translator,
  children
}: {
  translator: Translator
  children: ReactNode
}) {
  return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>
}

export function useI18n(): Translator {
  return useContext(I18nContext)
}
