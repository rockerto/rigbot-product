// lib/firebase-admin.ts
import { initializeApp, cert, getApps, getApp } from "firebase-admin/app";
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

const app = !getApps().length
  ? initializeApp({
      credential: cert(serviceAccount),
    })
  : getApp();

const db = getFirestore(app);

export { db };
