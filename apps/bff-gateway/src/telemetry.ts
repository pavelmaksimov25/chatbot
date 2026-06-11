// Must be imported before any other module so the instrumentation hooks
// register ahead of the libraries they patch.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';

// No collector configured (unit tests, bare local runs) → telemetry stays off.
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      // fetch() goes through undici, not node:http — without this the
      // BFF → api hop drops the trace context.
      new UndiciInstrumentation(),
      new PinoInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });
  sdk.start();
  process.on('SIGTERM', () => {
    void sdk.shutdown();
  });
}
