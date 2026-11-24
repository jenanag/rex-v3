import type { Config } from "./config.js";

export async function startTelemetry(config: Config) {
  if (!config.OTEL_EXPORTER_OTLP_ENDPOINT) return async () => {};
  const [{ NodeSDK }, { getNodeAutoInstrumentations }] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/auto-instrumentations-node"),
  ]);
  const sdk = new NodeSDK({
    serviceName: config.SERVICE_NAME,
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  return () => sdk.shutdown();
}
