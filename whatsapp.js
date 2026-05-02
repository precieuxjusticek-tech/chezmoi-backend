// ===================================================
// SERVICE WHATSAPP — UltraMsg
// ===================================================
const fetch  = require("node-fetch");
const crypto = require("crypto");

// ===================================================
// NORMALISATION NUMÉRO CONGO
// ===================================================
const WHATSAPP_BOT_URL = process.env.WHATSAPP_BOT_URL || "http://localhost:3001/send-message";

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

async function sendWhatsApp(phoneRaw, message) {
  const phone = normaliserNumero(phoneRaw);

  if (!phone || phone.length < 9) {
    console.warn(`[WhatsApp] ⚠️ Numéro invalide ignoré: ${phoneRaw}`);
    return;
  }

  try {
    const res = await fetch(WHATSAPP_BOT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, message })
    });

    const data = await res.json();

    if (data.success) {
      console.log(`[WhatsApp] ✅ Livré à ${phone}`);
    } else {
      console.error(`[WhatsApp] ❌ Échec pour ${phone}:`, data.error);
    }
  } catch (err) {
    console.error(`[WhatsApp] ❌ Erreur pour ${phone}: ${err.message}`);
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

  ━━━━━━━━━━━━━━
  👉 ACTION REQUISE : clique sur un choix ci-dessous
  ━━━━━━━━━━━━━━

  🟢 [ J'ACCEPTE CE LOCATAIRE ]
  ${backendUrl}/api/whatsapp/action/accept?token=${token}

  🟠 [ BIEN DÉJÀ LOUÉ ]
  ${backendUrl}/api/whatsapp/action/loue?token=${token}

  🔴 [ PAS INTÉRESSÉ ]
  ${backendUrl}/api/whatsapp/action/refuse?token=${token}

  ⏳ Un seul clic suffit. Lien valide 24h.
  ${compteur}/5 demandes aujourd'hui.`;
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

function msgAfterAccept({ prenomDemandeur, numeroDemandeur, nomProprio, numeroProprio, quartier, prix }) {
  return `🎉 EXCELLENTE NOUVELLE ${prenomDemandeur} !

  ${nomProprio} vient d'accepter ta demande 🖤
  Il a ton numéro et va te contacter.
  Ou appelle-le direct : 📞 ${numeroProprio}

  Message prêt :
  "Bonjour ${nomProprio}, c'est ${prenomDemandeur} via ChezMoi. Je suis intéressé par le bien ${quartier} à ${Number(prix).toLocaleString("fr-FR")} FC. Dispo quand pour visiter ?"`;
}

function msgAfterAcceptProprio({ nomProprio, prenomDemandeur, numeroDemandeur, quartier, prix }) {
  return `Merci ${nomProprio} 🙏 Contact envoyé à ${prenomDemandeur} !

  Voici son numéro : ${numeroDemandeur}

  Message suggéré :
  "Bonjour ${prenomDemandeur}, c'est ${nomProprio} de ChezMoi. Pour le bien ${quartier} à ${Number(prix).toLocaleString("fr-FR")} FC, dispo quand ?"

  ⚠️ 1 plainte arnaque = suppression directe
  2 plaintes = bannissement définitif`;
}

function msgAfterAcceptAdmin({ annonceId, nomProprio, prenomDemandeur }) {
  return `✅ PROPRIO A ACCEPTÉ
  Annonce ${annonceId}
  ${nomProprio} a accepté ${prenomDemandeur}`;
}

function msgAfterLoue({ prenomDemandeur }) {
  return `😔 Désolé ${prenomDemandeur},
  le propriétaire indique que ce bien est déjà loué.

  ChezMoi continue de chercher pour toi 🔎`;
}

function msgAfterLoueAdmin({ annonceId, nomProprio }) {
  return `🔒 ANNONCE FERMÉE
  Annonce ${annonceId} marquée déjà louée par ${nomProprio}`;
}

function msgAfterRefuse({ prenomDemandeur }) {
  return `😕 ${prenomDemandeur}, le propriétaire n'est pas intéressé pour cette demande.

  ChezMoi libère ta place pour d'autres opportunités.`;
}

function msgAfterRefuseAdmin({ annonceId, nomProprio, prenomDemandeur }) {
  return `❌ DEMANDE REFUSÉE
  Annonce ${annonceId}
  ${nomProprio} a refusé ${prenomDemandeur}`;
}

module.exports = {
  sendWhatsApp,
  generateSecureToken,
  creerActionRequest,
  getCompteurJournalier,
  msgProprietaire,
  msgAdmin,
  msgDemandeur,
  // ← nouvelles
  msgAfterAccept,
  msgAfterAcceptProprio,
  msgAfterAcceptAdmin,
  msgAfterLoue,
  msgAfterLoueAdmin,
  msgAfterRefuse,
  msgAfterRefuseAdmin
};