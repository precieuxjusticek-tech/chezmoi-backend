// ===================================================
// SERVICE WHATSAPP — UltraMsg
// ===================================================
const axios  = require("axios");
const crypto = require("crypto");

// ===================================================
// NORMALISATION NUMÉRO CONGO
// ===================================================
function normaliserNumero(phone) {
  let num = String(phone || "").replace(/\D/g, "");
  if (num.length === 9 && (num.startsWith("06") || num.startsWith("05") || num.startsWith("04"))) {
    num = "242" + num;
  }
  if (num.length === 10 && num.startsWith("0")) {
    num = "242" + num.substring(1);
  }
  console.log(`[WhatsApp] Numéro normalisé: ${phone} → ${num}`);
  return num;
}

// ===================================================
// ENVOI WHATSAPP
// ===================================================
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
      new URLSearchParams({ token, to: phone, body: message }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    if (res.data?.sent === "true" || res.data?.sent === true) {
      console.log(`[WhatsApp] ✅ Livré à ${phone} (id: ${res.data?.id})`);
    } else {
      console.error(`[WhatsApp] ❌ Échec pour ${phone}:`, res.data);
    }
  } catch (err) {
    console.error(`[WhatsApp] ❌ Erreur pour ${phone}: ${err.message}`);
    if (err.response) console.error(`[WhatsApp] Détail:`, JSON.stringify(err.response.data));
  }
}

// ===================================================
// TOKEN SÉCURISÉ
// ===================================================

/**
 * Génère un token unique et sécurisé
 * @returns {string} token hex 64 caractères
 */
function generateSecureToken() {
  return crypto.randomBytes(32).toString("hex");
}

// ===================================================
// COMPTEUR JOURNALIER PAR ANNONCE (Firestore)
// ===================================================

/**
 * Compte le nombre de demandes pour une annonce aujourd'hui
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} annonceId
 * @returns {Promise<number>} nombre de demandes aujourd'hui
 */
async function getCompteurJournalier(db, annonceId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { Timestamp } = require("firebase-admin").firestore;
  const todayTs = Timestamp.fromDate(today);

  const snap = await db.collection("contact_requests")
    .where("annonceId", "==", annonceId)
    .where("createdAt", ">=", todayTs)
    .get();

  return snap.size;
}

// ===================================================
// SAUVEGARDER ACTION REQUEST
// ===================================================

/**
 * Crée et sauvegarde une actionRequest en Firestore
 * Retourne le token généré
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} params
 * @returns {Promise<string>} token
 */
async function creerActionRequest(db, { annonceId, ownerUid, requesterUid }) {
  const { Timestamp } = require("firebase-admin").firestore;

  const token    = generateSecureToken();
  const now      = new Date();
  const expireAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +24h

  await db.collection("action_requests").doc(token).set({
    token,
    annonceId,
    ownerUid,
    requesterUid,
    createdAt: Timestamp.fromDate(now),
    expireAt:  Timestamp.fromDate(expireAt),
    status:    "pending"
  });

  console.log(`[ActionRequest] ✅ Token créé pour annonce ${annonceId}: ${token.substring(0, 8)}...`);
  return token;
}

// ===================================================
// FORMATAGE DES 3 MESSAGES
// ===================================================

/**
 * Message propriétaire AVEC liens d'action
 */
function msgProprietaire({ nomProprio, titre, prix, ville, prenomDemandeur, urgence, budget, token, compteur }) {
  const backendUrl = process.env.BACKEND_URL || "https://chezmoi-backend.onrender.com";
  return `Salut ${nomProprio} 👋 C'est ChezMoi !

Un locataire sérieux veut ton bien :
🏠 ${titre} - ${Number(prix).toLocaleString("fr-FR")} FC - ${ville}

👤 ${prenomDemandeur} - Cherche ${urgence} - Budget ${budget}

Tu gères, tu décides 👑

✅ J'ACCEPTE
${backendUrl}/api/whatsapp/action/accept?token=${token}

🔒 DÉJÀ LOUÉ
${backendUrl}/api/whatsapp/action/loue?token=${token}

❌ PAS INTÉRESSÉ
${backendUrl}/api/whatsapp/action/refuse?token=${token}

Lien expire dans 24h ⏳
${compteur}/5 demandes aujourd'hui`;
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

module.exports = {
  sendWhatsApp,
  generateSecureToken,
  creerActionRequest,
  getCompteurJournalier,
  msgProprietaire,
  msgAdmin,
  msgDemandeur
};