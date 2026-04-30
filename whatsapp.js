// ===================================================
// SERVICE WHATSAPP — UltraMsg
// ===================================================
const axios = require("axios");

/**
 * Envoie un message WhatsApp via UltraMsg
 * @param {string} phone  - numéro sans espaces, ex: "242060000000"
 * @param {string} message - texte du message
 */
async function sendWhatsApp(phone, message) {
  const instanceId = process.env.ULTRAMSG_INSTANCE_ID;
  const token      = process.env.ULTRAMSG_TOKEN;
  const baseUrl    = process.env.ULTRAMSG_BASE_URL;

  if (!instanceId || !token || !baseUrl) {
    console.warn("[WhatsApp] ⚠️  Variables UltraMsg manquantes — message non envoyé");
    return;
  }

  const url = `${baseUrl}/instance${instanceId}/messages/chat`;

  try {
    const res = await axios.post(
      url,
      new URLSearchParams({
        token: token,
        to:    phone,
        body:  message
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    console.log(`[WhatsApp] ✅ Envoyé à ${phone} — statut: ${res.data?.sent}`);
  } catch (err) {
    console.error(`[WhatsApp] ❌ Échec envoi à ${phone}: ${err.message}`);
    // On ne throw PAS — l'erreur WA ne bloque pas la réponse backend
  }
}

// ===================================================
// FORMATAGE DES 3 MESSAGES
// ===================================================

function msgProprietaire({ nomProprio, titre, prix, ville, prenomDemandeur, urgence, budget }) {
  return `Salut ${nomProprio} 👋 C'est ChezMoi !

    Un locataire sérieux veut ton bien :
    🏠 ${titre} - ${Number(prix).toLocaleString("fr-FR")} FC - ${ville}

    👤 ${prenomDemandeur} - Cherche ${urgence} - Budget ${budget}

    Réponds vite, demande fraîche 🔥`;
}

function msgAdmin({ titre, annonceId, prix, nomProprio, numeroProprio, prenomDemandeur, numeroDemandeur, urgence, budget, quartier }) {
  const ts = new Date().toLocaleString("fr-FR", { timeZone: "Africa/Brazzaville" });
  return `🔔 DEMANDE CHEZMOI

    Annonce: ${titre} #${annonceId}
    Prix: ${Number(prix).toLocaleString("fr-FR")} FC
    Proprio: ${nomProprio} ${numeroProprio}
    Demandeur: ${prenomDemandeur} ${numeroDemandeur}
    Urgence: ${urgence}
    Budget: ${budget}
    Quartier: ${quartier}
    Heure: ${ts}`;
}

function msgDemandeur({ prenomDemandeur, titre, quartier, prix }) {
  return `✅ Salut ${prenomDemandeur} !

    Ta demande ChezMoi a bien été envoyée au propriétaire 📨

    Annonce :
    🏠 ${titre}
    📍 ${quartier}
    💰 ${Number(prix).toLocaleString("fr-FR")} FC

    Le propriétaire examine ta demande.
    ChezMoi te prévient dès qu'il répond.`;
}

module.exports = { sendWhatsApp, msgProprietaire, msgAdmin, msgDemandeur };