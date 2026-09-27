import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { access, cp, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  throw new Error("Usage: node scripts/import-local-data.mjs <source-data-dir> <new-target-data-dir>");
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function importLocalData(sourceArgument, targetArgument) {
  if (!sourceArgument || !targetArgument) usage();
  const source = path.resolve(sourceArgument);
  const target = path.resolve(targetArgument);
  if (source === target) throw new Error("Source and target directories must differ");

  const sourceDatabase = path.join(source, "taskboard.sqlite");
  if (!(await stat(sourceDatabase).catch(() => null))?.isFile()) {
    throw new Error(`Source database does not exist: ${sourceDatabase}`);
  }
  if (await access(target).then(() => true, () => false)) {
    throw new Error(`Target already exists; choose a new directory: ${target}`);
  }

  await mkdir(path.dirname(target), { recursive: true });
  const staging = path.join(path.dirname(target), `.${path.basename(target)}-import-${randomUUID()}`);
  await mkdir(staging);
  try {
    const sourceConnection = new DatabaseSync(sourceDatabase, { readOnly: true });
    try {
      const tables = new Set(sourceConnection.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
      if (!tables.has("projects") || !tables.has("tasks")) {
        throw new Error("Source is not a Taskboard SQLite database");
      }
      sourceConnection.exec(`VACUUM INTO ${sqlString(path.join(staging, "taskboard.sqlite"))}`);
    } finally {
      sourceConnection.close();
    }

    const sourceAttachments = path.join(source, "attachments");
    if ((await stat(sourceAttachments).catch(() => null))?.isDirectory()) {
      await cp(sourceAttachments, path.join(staging, "attachments"), { recursive: true });
    }
    await rename(staging, target);
    return target;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  importLocalData(process.argv[2], process.argv[3])
    .then((target) => console.log(`Imported Taskboard data into ${target}`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
