import { prepareTestDatabase, testDbUrls } from '@wacrm/db/testing';

// Own database so this suite can run in parallel with packages/db.
export default async function setup() {
  await prepareTestDatabase(testDbUrls('wacrm_api_test'));
}
