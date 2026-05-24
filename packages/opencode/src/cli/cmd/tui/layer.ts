import { Layer } from "effect"
import { TuiConfig } from "./config/tui"
import { Npm } from "@nous-ai/core/npm"
import { Observability } from "@nous-ai/core/effect/observability"

export const CliLayer = Observability.layer.pipe(Layer.merge(TuiConfig.layer), Layer.provide(Npm.defaultLayer))
