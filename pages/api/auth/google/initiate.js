// pages/api/auth/google/initiate.js

export default async function handler(req, res) {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "Falta el parámetro userId en la URL" });
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI; // Ej: https://rigbot-product.vercel.app/api/auth/google/callback

  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: "Faltan variables de entorno del cliente OAuth o redirectUri" });
  }

  const scope = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "openid",
    "email",
    "profile"
  ].join(" ");

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent"); // Para forzar refreshToken
  authUrl.searchParams.set("state", userId); // Lo usaremos al volver en el callback

  return res.redirect(authUrl.toString());
}
