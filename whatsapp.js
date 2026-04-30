// ===================================================
// SERVICE WHATSAPP — UltraMsg
// ===================================================
const axios = require("axios");

async function sendWhatsApp(phone, message) {
  const instanceId = process.env.ULTRAMSG_INSTANCE_ID;
  const token      = process.env.ULTRAMSG_TOKEN;
  const baseUrl    = process.env.ULTRAMSG_BASE_URL;

  if (!instanceId || !token || !baseUrl) {
    console.warn("[WhatsApp] ⚠️ Variables manquantes:", { instanceId: !!instanceId, token: !!token, baseUrl: !!baseUrl });
    return;
  }

  // URL propre — baseUrl ne contient PAS l'instanceId
  const url = `${baseUrl}/${instanceId}/messages/chat`;
  console.log(`[WhatsApp] → URL: ${url}`);
  console.log(`[WhatsApp] → Destinataire: ${phone}`);

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

    // Log complet pour diagnostic
    console.log(`[WhatsApp] Réponse brute:`, JSON.stringify(res.data));

    if (res.data?.sent === "true" || res.data?.sent === true) {
      console.log(`[WhatsApp] ✅ Message livré à ${phone}`);
    } else {
      console.error(`[WhatsApp] ❌ Échec pour ${phone}:`, res.data);
    }

  } catch (err) {
    console.error(`[WhatsApp] ❌ Erreur HTTP pour ${phone}: ${err.message}`);
    if (err.response) {
      console.error(`[WhatsApp] Réponse erreur:`, JSON.stringify(err.response.data));
    }
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