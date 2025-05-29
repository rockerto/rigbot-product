// /lib/chat_modules/config_manager.js
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '@/lib/defaultSystemPromptTemplate'; // Asumiendo que este archivo existe

export const WHATSAPP_FALLBACK_PLACEHOLDER = "+56900000000";

export const defaultConfig = {
  basePrompt: process.env.RIGBOT_PROMPT || DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  calendarQueryDays: 7,
  calendarMaxUserRequestDays: 21,
  maxSuggestions: 5,
  whatsappNumber: process.env.RIGBOT_DEFAULT_WSP || WHATSAPP_FALLBACK_PLACEHOLDER,
  pricingInfo: "Nuestros precios son competitivos. Por favor, consulta al contactarnos.",
  direccion: "Nuestra consulta está en Copiapó. Te daremos los detalles exactos al agendar.",
  horario: "Atendemos de Lunes a Viernes, de 10:00 a 19:30.",
  chiropracticVideoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  telefono: ""
};

export function getEffectiveConfig(clientConfigData) {
  let mergedConfig = { ...defaultConfig }; // Empezar con los defaults
  if (clientConfigData) {
    // Sobrescribir con clientConfigData, asegurando que los tipos sean correctos y haya fallbacks
    mergedConfig.basePrompt = clientConfigData.basePrompt || defaultConfig.basePrompt;
    mergedConfig.calendarQueryDays = Number(clientConfigData.calendarQueryDays) || defaultConfig.calendarQueryDays;
    mergedConfig.calendarMaxUserRequestDays = Number(clientConfigData.calendarMaxUserRequestDays) || defaultConfig.calendarMaxUserRequestDays;
    mergedConfig.maxSuggestions = clientConfigData.maxSuggestions !== undefined ? Number(clientConfigData.maxSuggestions) : defaultConfig.maxSuggestions;
    mergedConfig.whatsappNumber = String(clientConfigData.whatsappNumber || defaultConfig.whatsappNumber).trim();
    mergedConfig.pricingInfo = String(clientConfigData.pricingInfo || defaultConfig.pricingInfo);
    mergedConfig.direccion = String(clientConfigData.direccion || defaultConfig.direccion);
    mergedConfig.horario = String(clientConfigData.horario || defaultConfig.horario);
    mergedConfig.chiropracticVideoUrl = String(clientConfigData.chiropracticVideoUrl || defaultConfig.chiropracticVideoUrl);
    mergedConfig.telefono = String(clientConfigData.telefono || defaultConfig.telefono);
    
    // Añadir cualquier otro campo específico del cliente que no esté en defaultConfig pero que se use
    mergedConfig.name = clientConfigData.name || "";
    mergedConfig.plan = clientConfigData.plan || "free";
    mergedConfig.fallbackMessage = clientConfigData.fallbackMessage || "Lo siento, no te he entendido. ¿Podrías intentarlo de nuevo?";
    mergedConfig.email = clientConfigData.email || "";
    mergedConfig.clientId = clientConfigData.clientId || ""; // El ID del documento del cliente
    mergedConfig.createdAt = clientConfigData.createdAt;
    mergedConfig.welcomeMessage = clientConfigData.welcomeMessage || "";

    // Campos de Google Calendar
    mergedConfig.googleCalendarConnected = clientConfigData.googleCalendarConnected || false;
    mergedConfig.googleCalendarUserName = clientConfigData.googleCalendarUserName || "";
    mergedConfig.googleCalendarError = clientConfigData.googleCalendarError || null;
    mergedConfig.googleCalendarEmail = clientConfigData.googleCalendarEmail || "";
    mergedConfig.googleCalendarTokens = clientConfigData.googleCalendarTokens || null; // Este es sensible
    mergedConfig.googleCalendarLastSync = clientConfigData.googleCalendarLastSync || null;

  }
  return mergedConfig;
}