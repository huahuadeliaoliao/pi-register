import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { acquireLease } from "../src/lease.ts";
import { newRevision, type Revision } from "../src/model.ts";
import { RevisionStore } from "../src/store.ts";

const [database, barrier, name] = process.argv.slice(2);
if (!database || !barrier || !name) throw new Error("Missing isolated worker arguments");
writeFileSync(`${barrier}.${name}`, "ready");
while (!existsSync(barrier)) await delay(5);
const store = new RevisionStore(database);
const lease = acquireLease(store, `${database}.${name}.session`);
let previous: Revision | undefined;
for (let batch = 0; batch < 20; batch++) {
	const revisions: Revision[] = [];
	for (let step = 0; step < 3; step++) {
		const revision = newRevision(`${name}:${batch * 3 + step}`, previous, previous ? "append" : "create", name);
		revisions.push(revision);
		previous = revision;
	}
	store.transaction(() => {
		for (const revision of revisions) store.put(revision);
	});
}
lease.assertOwned();
lease.release();
store.close();
console.log(JSON.stringify({ name, last: previous?.id, count: 60, pid: process.pid }));
