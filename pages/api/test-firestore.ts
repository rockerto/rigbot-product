// pages/api/test-firestore.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "../../lib/firebase-admin";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const docRef = await db.collection("test_logs").add({
      timestamp: Date.now(),
      message: "¡Conexión exitosa con Firestore desde Rigbot-product!",
    });

    res.status(200).json({
      success: true,
      message: "Documento creado correctamente.",
      docId: docRef.id,
    });
  } catch (error) {
    console.error("Error al escribir en Firestore:", error);
    res.status(500).json({
      success: false,
      message: "Error al conectar con Firestore.",
    });
  }
}
