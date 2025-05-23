(() => {
  const backendUrl = window.NEXT_PUBLIC_RIGBOT_BACKEND_URL || 'https://rigbot-1-0.vercel.app/api/chat';
  // Obtener el clientId que el dueño del sitio web debe definir
  const rigbotClientId = window.RIGBOT_CLIENT_ID || 'demo-client'; // Fallback a 'demo-client'

  let chatWindowInstance = null; // Para controlar la instancia de la ventana de chat
  let chatBubbleInstance = null; // Para controlar la instancia de la burbuja de chat
  let whatsappBubbleInstance = null; // Para controlar la instancia de la burbuja de WhatsApp


  const createBubbles = () => {
    // Evitar crear múltiples burbujas si el script se carga o ejecuta varias veces
    if (document.getElementById('rigbot-bubble-chat-custom')) return;

    // Burbuja del Chatbot Rigbot
    chatBubbleInstance = document.createElement('div');
    chatBubbleInstance.id = 'rigbot-bubble-chat-custom';
    chatBubbleInstance.setAttribute('aria-label', 'Abrir chat con Rigbot');
    chatBubbleInstance.title = 'Chatear con Rigbot'; // Tooltip
    chatBubbleInstance.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 90px; /* Posición a la izquierda de la burbuja de WhatsApp */
      width: 60px; /* Ligeramente más pequeño para diferenciar */
      height: 60px;
      background-color: #007bff; /* Azul brillante, puedes cambiarlo */
      color: white;
      border-radius: 50%;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 9998; /* Ligeramente por debajo de la ventana de chat pero por encima del contenido normal */
      transition: transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out;
    `;
    chatBubbleInstance.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-message-square"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`; // Icono de chat simple
    
    chatBubbleInstance.onmouseenter = () => {
        chatBubbleInstance.style.transform = 'scale(1.1)';
        chatBubbleInstance.style.boxShadow = '0 6px 16px rgba(0,0,0,0.3)';
    };
    chatBubbleInstance.onmouseleave = () => {
        chatBubbleInstance.style.transform = 'scale(1)';
        chatBubbleInstance.style.boxShadow = '0 4px 12px rgba(0,0,0,0.25)';
    };

    document.body.appendChild(chatBubbleInstance);
    chatBubbleInstance.addEventListener('click', toggleChatWindow);

    // Burbuja de WhatsApp
    // CONSIDERACIÓN FUTURA: El número de WhatsApp está hardcodeado.
    // Idealmente, el widget podría obtener este número de una configuración
    // o como parte de la primera respuesta del bot si se quisiera personalizar por cliente.
    whatsappBubbleInstance = document.createElement('a');
    whatsappBubbleInstance.id = 'rigbot-bubble-whatsapp-custom';
    whatsappBubbleInstance.href = `https://wa.me/+56989967350`; // NÚMERO HARDCODEADO
    whatsappBubbleInstance.target = "_blank";
    whatsappBubbleInstance.setAttribute('aria-label', 'Contactar por WhatsApp');
    whatsappBubbleInstance.title = 'Contactar por WhatsApp'; // Tooltip
    whatsappBubbleInstance.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 60px;
      height: 60px;
      background-color: #25D366; /* Verde WhatsApp */
      color: white;
      border-radius: 50%;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 9998;
      text-decoration: none;
      transition: transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out;
    `;
    whatsappBubbleInstance.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>`; // Icono de WhatsApp

    whatsappBubbleInstance.onmouseenter = () => {
        whatsappBubbleInstance.style.transform = 'scale(1.1)';
        whatsappBubbleInstance.style.boxShadow = '0 6px 16px rgba(0,0,0,0.3)';
    };
    whatsappBubbleInstance.onmouseleave = () => {
        whatsappBubbleInstance.style.transform = 'scale(1)';
        whatsappBubbleInstance.style.boxShadow = '0 4px 12px rgba(0,0,0,0.25)';
    };
    document.body.appendChild(whatsappBubbleInstance);
  };

  const toggleChatWindow = () => {
    if (chatWindowInstance) {
      closeChatWindow();
    } else {
      openChatWindow();
    }
  };
  
  const openChatWindow = () => {
    if (document.getElementById('rigbot-window-custom')) return; // Evitar múltiples ventanas

    chatWindowInstance = document.createElement('div');
    chatWindowInstance.id = 'rigbot-window-custom';
    chatWindowInstance.style.cssText = `
      position: fixed;
      bottom: 90px; /* Encima de las burbujas */
      right: 20px;
      width: 350px; /* Un poco más ancho */
      max-width: 90vw;
      height: 500px; /* Un poco más alto */
      max-height: 70vh;
      background-color: #ffffff;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.2);
      display: flex;
      flex-direction: column;
      z-index: 10000; /* Por encima de todo */
      overflow: hidden;
      border: 1px solid #e0e0e0;
      font-family: 'Roboto', 'Segoe UI', Arial, sans-serif; /* Fuente más moderna */
      opacity: 0;
      transform: translateY(20px);
      transition: opacity 0.3s ease-out, transform 0.3s ease-out;
    `;

    // Aplicar estilos de entrada y aparición
    requestAnimationFrame(() => {
        chatWindowInstance.style.opacity = '1';
        chatWindowInstance.style.transform = 'translateY(0)';
    });

    chatWindowInstance.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background-color: #007bff; color: white; border-top-left-radius: 11px; border-top-right-radius: 11px;">
        <span style="font-weight: bold; font-size: 16px;">Rigbot Asistente</span>
        <button id="rigbot-close-custom" aria-label="Cerrar chat" style="background: none; border: none; color: white; font-size: 24px; cursor: pointer; line-height: 1;">&times;</button>
      </div>
      <div id="rigbot-chat-messages-custom" style="flex: 1; padding: 12px; overflow-y: auto; background-color: #f7f9fc; display: flex; flex-direction: column; gap: 8px;"></div>
      <div style="display: flex; border-top: 1px solid #e0e0e0; padding: 8px; background-color: #f0f0f0;">
        <input type="text" id="rigbot-input-custom" placeholder="Escribe tu mensaje..." style="flex: 1; border: 1px solid #ccc; border-radius: 20px; padding: 10px 15px; font-size: 14px; outline: none; margin-right: 8px;" />
        <button id="rigbot-send-custom" aria-label="Enviar mensaje" style="background-color: #007bff; color: white; border: none; border-radius: 50%; width: 40px; height: 40px; font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center;">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        </button>
      </div>
    `;
    document.body.appendChild(chatWindowInstance);

    document.getElementById('rigbot-close-custom').addEventListener('click', closeChatWindow);
    document.getElementById('rigbot-send-custom').addEventListener('click', sendMessage);
    document.getElementById('rigbot-input-custom').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); // Prevenir nueva línea en Enter simple
        sendMessage();
      }
    });

    // Mensaje de bienvenida:
    // CONSIDERACIÓN FUTURA: Este mensaje está hardcodeado.
    // Idealmente, el widget podría obtener el welcomeMessage de la configuración del cliente.
    addMessageToChat("Hola 👋 Soy Rigbot, tu asistente virtual. ¿En qué puedo ayudarte hoy?", 'bot');
    document.getElementById('rigbot-input-custom').focus();
  };

  const closeChatWindow = () => {
    if (chatWindowInstance) {
      chatWindowInstance.style.opacity = '0';
      chatWindowInstance.style.transform = 'translateY(20px)';
      setTimeout(() => {
        chatWindowInstance.remove();
        chatWindowInstance = null;
      }, 300); // Esperar que termine la animación
    }
  };

  const addMessageToChat = (text, sender = 'bot', isLoading = false) => {
    const chatMessagesContainer = document.getElementById('rigbot-chat-messages-custom');
    if (!chatMessagesContainer) return;

    // Remover mensaje de "escribiendo" si existe
    const existingTypingIndicator = document.getElementById('rigbot-typing-indicator');
    if (existingTypingIndicator && !isLoading) {
      existingTypingIndicator.remove();
    }
    
    const messageBubble = document.createElement('div');
    messageBubble.classList.add('rigbot-message-bubble');
    messageBubble.style.cssText = `
      padding: 10px 14px;
      border-radius: 18px;
      margin-bottom: 4px; /* Reducir espacio entre burbujas */
      max-width: 75%;
      word-wrap: break-word; /* Mejor que break-word */
      line-height: 1.4;
      font-size: 14px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.1);
    `;

    if (sender === 'user') {
      messageBubble.style.backgroundColor = '#007bff';
      messageBubble.style.color = 'white';
      messageBubble.style.marginLeft = 'auto'; // Alinea a la derecha
      messageBubble.style.borderBottomRightRadius = '4px';
    } else {
      messageBubble.style.backgroundColor = '#e9ecef';
      messageBubble.style.color = '#333';
      messageBubble.style.marginRight = 'auto'; // Alinea a la izquierda
      messageBubble.style.borderBottomLeftRadius = '4px';
    }

    if (isLoading) {
      messageBubble.id = 'rigbot-typing-indicator'; // Para poder removerlo específicamente
      messageBubble.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; height: 20px;">
          <div class="rigbot-dot-flashing" style="width: 6px; height: 6px; margin: 0 2px; background-color: #888; border-radius: 50%; animation: rigbotDotFlashing 1s infinite linear alternate;"></div>
          <div class="rigbot-dot-flashing" style="width: 6px; height: 6px; margin: 0 2px; background-color: #888; border-radius: 50%; animation: rigbotDotFlashing 1s infinite linear alternate; animation-delay: 0.2s;"></div>
          <div class="rigbot-dot-flashing" style="width: 6px; height: 6px; margin: 0 2px; background-color: #888; border-radius: 50%; animation: rigbotDotFlashing 1s infinite linear alternate; animation-delay: 0.4s;"></div>
        </div>
      `;
       // Añadir keyframes para la animación de los puntos
      if (!document.getElementById('rigbot-animation-styles')) {
        const styleSheet = document.createElement("style");
        styleSheet.id = 'rigbot-animation-styles';
        styleSheet.innerText = `
          @keyframes rigbotDotFlashing {
            0% { background-color: #888; }
            50%, 100% { background-color: #ccc; }
          }
        `;
        document.head.appendChild(styleSheet);
      }
    } else {
      messageBubble.textContent = text;
    }
    
    chatMessagesContainer.appendChild(messageBubble);
    chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight; // Auto-scroll
  };

  const sendMessage = async () => {
    const inputElement = document.getElementById('rigbot-input-custom');
    if (!inputElement) return;

    const text = inputElement.value.trim();
    if (!text) return;

    addMessageToChat(text, 'user');
    inputElement.value = ''; // Limpiar input
    inputElement.focus();   // Mantener foco en input

    addMessageToChat('', 'bot', true); // Indicador de "escribiendo..."

    // Log para debug sugerido por Rigo
    console.log("📦 Enviando a API con clientId:", rigbotClientId);

    try {
      const response = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ✅ CÓDIGO NUEVO: Enviando clientId
        body: JSON.stringify({
          message: text,
          clientId: rigbotClientId
          // Si manejas session ID en el widget, envíalo aquí:
          // sessionId: tuVariableSessionId
        })
      });
      
      const existingTypingIndicator = document.getElementById('rigbot-typing-indicator');
      if (existingTypingIndicator) {
        existingTypingIndicator.remove();
      }

      if (!response.ok) {
        // Intenta leer el error del backend si está en JSON
        let errorData;
        try {
            errorData = await response.json();
        } catch (e) { /* No es JSON o está vacío */ }
        console.error('Error en la respuesta del servidor:', response.status, errorData);
        addMessageToChat(errorData?.error || 'Hubo un problema con la respuesta del servidor.', 'bot');
        return;
      }

      const data = await response.json();
      addMessageToChat(data.response || 'Lo siento, no he podido procesar eso en este momento.', 'bot');

    } catch (err) {
      console.error('❌ Error en fetch Rigbot:', err);
      const existingTypingIndicator = document.getElementById('rigbot-typing-indicator');
      if (existingTypingIndicator) {
        existingTypingIndicator.remove();
      }
      addMessageToChat('❌ Ups, parece que hay un problema de conexión. Intenta de nuevo.', 'bot');
    }
  };

  // Crear las burbujas solo una vez cuando la página carga
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    createBubbles();
  } else {
    window.addEventListener('load', createBubbles);
  }

})();