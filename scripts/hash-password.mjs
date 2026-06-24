import crypto from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rl = readline.createInterface({ input, output });
const password = await rl.question("Shared app password: ");
rl.close();

const hash = crypto.createHash("sha256").update(password, "utf8").digest("hex");
console.log(hash);
