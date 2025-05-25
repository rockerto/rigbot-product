// rigbot-product/lib/firebase-admin.ts
import { initializeApp, cert, getApps, getApp, App } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";

let app: App;
let db: Firestore;

if (!getApps().length) {
  try {
    const serviceAccountString = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!serviceAccountString || serviceAccountString.trim() === "") {
      console.error("CRITICAL ERROR: La variable de entorno GOOGLE_APPLICATION_CREDENTIALS no está definida o está vacía en Vercel para el proyecto rigbot-product.");
      throw new Error("GOOGLE_APPLICATION_CREDENTIALS no definida o vacía.");
    }
    
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(serviceAccountString); 
    } catch (parseError) {
      console.error("CRITICAL ERROR: No se pudo parsear el JSON de GOOGLE_APPLICATION_CREDENTIALS. Verifica que el valor sea un JSON válido y completo en Vercel. Error de parseo:", parseError);
      console.error("Valor problemático (primeros/últimos 100 chars):", serviceAccountString.substring(0,100), "...", serviceAccountString.slice(-100));
      throw new Error("GOOGLE_APPLICATION_CREDENTIALS no es un JSON válido.");
    }
    
    app = initializeApp({
      credential: cert(serviceAccount)
    });
    console.log("Firebase Admin SDK inicializado con credenciales parseadas explícitamente desde firebase-admin.ts.");
    db = getFirestore(app);

  } catch (e) {
    console.error("Error GLOBAL CRÍTICO durante la inicialización de Firebase Admin SDK en firebase-admin.ts:", (e as Error).message);
    // Si hay un error aquí, db y app podrían no estar disponibles o ser inválidos.
    // Las funciones que los usen deben verificar.
  }
} else {
  app = getApp();
  db = getFirestore(app);
  console.log("Firebase Admin SDK ya estaba inicializado (firebase-admin.ts).");
}

export { db, app }; // Exportar db y app (aunque app no se usa directamente en chat.js ahora)