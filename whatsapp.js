// ===================================================
// SERVICE WHATSAPP — UltraMsg
// ===================================================
const axios = require("axios");

// Normalise un numéro au format international Congo (242XXXXXXXXX)
function normaliserNumero(phone) {
  let num = String(phone || "").replace(/\D/g, "");

  // Format local congolais : 06XXXXXXX ou 05XXXXXXX (9 chiffres)
  if (num.length === 9 && (num.startsWith("06") || num.startsWith("05") || num.startsWith("04"))) {
    num = "242" + num;
  }

  // Format avec 0 devant : 0XXXXXXXXX (10 chiffres)
  if (num.length === 10 && num.startsWith("0")) {
    num = "242" + num.substring(1);
  }

  console.log(`[WhatsApp] Numéro normalisé: ${phone} → ${num}`);
  return num;
}

async function sendWhatsApp(phoneRaw, message) {
  const phone      = normaliserNumero(phoneRaw);
  const instanceId = process.env.ULTRAMSG_INSTANCE_ID;
  const token      = process.env.ULTRAMSG_TOKEN;
  const baseUrl    = process.env.ULTRAMSG_BASE_URL;

  if (!instanceId || !token || !baseUrl) {
    console.warn("[WhatsApp] ⚠️ Variables manquantes");
    return;
  }

  if (!phone || phone.length < 9) {
    console.warn(`[WhatsApp] ⚠️ Numéro invalide ignoré: ${phoneRaw}`);
    return;
  }

  const url = `${baseUrl}/${instanceId}/messages/chat`;

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

    if (res.data?.sent === "true" || res.data?.sent === true) {
      console.log(`[WhatsApp] ✅ Livré à ${phone} (id: ${res.data?.id})`);
    } else {
      console.error(`[WhatsApp] ❌ Échec pour ${phone}:`, res.data);
    }

  } catch (err) {
    console.error(`[WhatsApp] ❌ Erreur pour ${phone}: ${err.message}`);
    if (err.response) {
      console.error(`[WhatsApp] Détail:`, JSON.stringify(err.response.data));
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