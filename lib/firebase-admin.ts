// lib/firebase-admin.ts (22 mayo 2025, 21:40 hrs)

import { initializeApp, cert, getApps, getApp, App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as fs from "fs";
import * as path from "path";

const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!credentialsPath) {
  throw new Error("Falta la variable GOOGLE_APPLICATION_CREDENTIALS");
}

// Leer el archivo manualmente como string y parsearlo a JSON
const serviceAccount = JSON.parse(
  fs.readFileSync(path.resolve(credentialsPath), "utf-8")
);

const app: App = !getApps().length
  ? initializeApp({
      credential: cert(serviceAccount),
    })
  : getApp();

const db = getFirestore(app);

// 👇 Aquí exportamos tanto db como app, para quien los necesite
export { db, app };
