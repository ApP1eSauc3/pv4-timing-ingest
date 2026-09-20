/** Re-records the stack snapshot. Read the diff before committing it. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { currentTemplate } from '../test/stack-snapshot.test';

const path = join(__dirname, '..', 'test', '__snapshots__', 'Pv4TimingStack.json');
writeFileSync(path, `${JSON.stringify(currentTemplate(), null, 2)}\n`);
console.log(`recorded ${path}`);
