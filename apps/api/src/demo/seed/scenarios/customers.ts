import type { DemoScenario } from '../context.ts';
import { DEMO_CUSTOMERS } from '../data.ts';
import { createDemoCustomer } from './builders.ts';

/**
 * Privatkunde, Organisation und der spätere Wiedermieter (Order §10) über
 * CustomerService.createCustomer – Dubletten werden dort nur gewarnt, nie
 * blockiert. Alle weiteren Kunden entstehen in ihren Vorgangs-Szenarien.
 */
export const customersScenario: DemoScenario = {
  name: 'customers',
  async run(ctx) {
    await createDemoCustomer(ctx, DEMO_CUSTOMERS.privateBasic);
    await createDemoCustomer(ctx, DEMO_CUSTOMERS.orgBasic);
    await createDemoCustomer(ctx, DEMO_CUSTOMERS.privateRepeat);
  },
};
