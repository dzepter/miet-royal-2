import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { JobQueue, JobRunner, JobRunnerLogger } from '@mietroyal/integrations';
import type { SessionLifecycleListener } from '../auth/service.ts';
import { createPushGateway } from '../communication/push/gateways.ts';
import { PushService } from '../communication/push/push-service.ts';
import { PushRuleScanner } from '../communication/push/rules.ts';
import type { PermissionResolver } from '../communication/push/recipients.ts';
import { createPushSendHandler } from '../communication/push/send-job.ts';
import { createPushSessionListener } from '../communication/push/session-listener.ts';
import { PushSubscriptionService } from '../communication/push/subscription-service.ts';
import type { PushGateway } from '../communication/types.ts';
import { PUSH_SEND_JOB_TYPE } from '../communication/types.ts';

/**
 * Phase 12 (push): Web-Push-Jobs und -Dienste für API und Worker.
 * `createPushModule` baut die Dienste (eine Stelle für beide Prozesse);
 * `registerPushJobHandlers` hängt `push.send` an einen Runner. Der zentrale
 * `communication.scan_due`-Job (Agent R) ruft `rules.scanDue(now)` auf.
 */
export interface PushModuleDeps {
  db: Database;
  config: AppConfig;
  queue: JobQueue;
  /** Test-Injection (FakePushGateway); Default laut config.push (WebPush/Disabled). */
  gateway?: PushGateway;
  logger?: JobRunnerLogger;
}

export interface PushModule {
  gateway: PushGateway;
  subscriptions: PushSubscriptionService;
  push: PushService;
  rules: PushRuleScanner;
}

/** Auth-Anbindung: Rechteauflösung (Pflicht) + Session-Hooks (API; im Worker nicht nötig). */
export type PushAuthPort = PermissionResolver & {
  addSessionListener?(listener: SessionLifecycleListener): void;
};

export function createPushModule(deps: PushModuleDeps, auth: PushAuthPort): PushModule {
  const gateway = deps.gateway ?? createPushGateway(deps.config);
  if (deps.config.appEnv === 'production' && gateway.kind === 'fake') {
    throw new Error('FakePushGateway ist in production nicht zulässig');
  }
  const subscriptions = new PushSubscriptionService(deps.db);
  const push = new PushService(deps.db, deps.queue, deps.logger);
  const rules = new PushRuleScanner({
    db: deps.db,
    push,
    auth,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
  auth.addSessionListener?.(
    createPushSessionListener({
      subscriptions,
      rules,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    }),
  );
  return { gateway, subscriptions, push, rules };
}

export function registerPushJobHandlers(
  runner: JobRunner,
  deps: {
    db: Database;
    subscriptions: PushSubscriptionService;
    gateway: PushGateway;
    logger?: JobRunnerLogger;
  },
): void {
  runner.register(
    PUSH_SEND_JOB_TYPE,
    createPushSendHandler({
      db: deps.db,
      subscriptions: deps.subscriptions,
      gateway: deps.gateway,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    }),
  );
}

export {
  PUSH_SEND_JOB_TYPE,
  createPushGateway,
  PushRuleScanner,
  PushService,
  PushSubscriptionService,
};
// Für den Worker (Rechteauflösung der Admin-Pushes ohne eigenen Auth-Export).
export { StaffAuthService } from '../auth/service.ts';
export { createMailAdapter } from '../auth/mail.ts';
