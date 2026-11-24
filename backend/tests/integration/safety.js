import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readEnvFile(fileName) {
  const filePath = path.join(backendDirectory, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required environment file is missing: backend\\${fileName}`);
  }
  return dotenv.parse(fs.readFileSync(filePath));
}

function getDatabaseHost(value, key, fileName) {
  if (!value) {
    throw new Error(`${key} is missing from backend\\${fileName}`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} in backend\\${fileName} is not a valid database URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`${key} in backend\\${fileName} must use PostgreSQL`);
  }
  return url.hostname;
}

export function configureTestDatabase() {
  const testEnvironment = readEnvFile('.env.test');
  const testDatabaseUrl = testEnvironment.TEST_DATABASE_URL;
  const testHost = getDatabaseHost(testDatabaseUrl, 'TEST_DATABASE_URL', '.env.test');

  const productionEnvironment = readEnvFile('.env');
  const productionHost = getDatabaseHost(
    productionEnvironment.DATABASE_URL,
    'DATABASE_URL',
    '.env',
  );

  if (testHost.toLowerCase() === productionHost.toLowerCase()) {
    throw new Error(
      `Refusing integration tests: test database host ${testHost} matches configured database host ${productionHost}.`,
    );
  }

  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.NODE_ENV = 'production';
  return testHost;
}
