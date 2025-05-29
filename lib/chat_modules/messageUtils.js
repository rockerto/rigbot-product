// /lib/chat_modules/messageUtils.js
export function getWhatsappContactMessage(contactNumber, fallbackPlaceholder = "+56900000000") {
    const wsp = String(contactNumber || '').trim();
   if (wsp && wsp !== fallbackPlaceholder && wsp !== "") {
     return ` Para más detalles o para agendar, conversemos por WhatsApp 👉 ${wsp}`;
   }
   return " Para más detalles o para agendar, por favor contáctanos a través de nuestros canales principales.";
}

export function getWhatsappDerivationSuffix(contactNumber, fallbackPlaceholder = "+56900000000") {
    const wsp = String(contactNumber || '').trim();
   if (wsp && wsp !== fallbackPlaceholder && wsp !== "") {
     return ` ¡Escríbenos por WhatsApp al 👉 ${wsp}!`;
   }
   return " ¡Contáctanos para coordinar!";
}