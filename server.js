/* ======== process.env ======== */
require("dotenv").config();
/* ===================================================== */
/* ================= IMPORTS =========================== */
/* ===================================================== */
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const fetch = require("node-fetch"); // pour Imgbb
const nodemailer = require("nodemailer"); // pour email
const webhookSecret = process.env.YABETOO_WEBHOOK_SECRET; // pour le webhook
const YABETOOPAY_API_KEY = process.env.YABETOOPAY_API_KEY; // la clé api
const YABETOOPAY_SECRET_KEY = process.env.YABETOOPAY_SECRET_KEY; // la clé api secrete
const YABETOOPAY_MERCHANT_ID = process.env.YABETOOPAY_MERCHANT_ID; // la clé merchant


/* ===================================================== */
/* ================= INITIALISATION ==================== */
/* ===================================================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;

/* ===================================================== */
/* ================= FIREBASE ADMIN ==================== */
/* ===================================================== */
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

/* ===================================================== */
/* ==================== AUTH ========================== */
/* ===================================================== */

/* --- INSCRIPTION --- */
app.post("/api/register", async (req, res) => {
    const { nom, email, password, inscontact } = req.body;
    // --- Validation basique avant d'envoyer à Firebase ---
    if (!nom || !email || !password || !inscontact) {
        return res.status(400).json({ message: "Tous les champs sont obligatoires" });
    }
    if (typeof inscontact !== "string" || inscontact.length < 5) {
        return res.status(400).json({ message: "Le contact est invalide" });
    }
    try {
        const userRecord = await admin.auth().createUser({ email, password });
        await db.collection("users").doc(userRecord.uid).set({
            uid: userRecord.uid,
            nom,
            email,
            inscontact,
            createdAt: admin.firestore.Timestamp.now()
        });
        res.status(201).json({ message: "Utilisateur créé", uid: userRecord.uid });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
});

/* --- CONNEXION --- */
app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;
    try {
        const apiKey = process.env.FIREBASE_API_KEY;
        const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, returnSecureToken: true })
        });
        const data = await response.json();
        if (data.error) return res.status(400).json({ message: data.error.message });
        res.status(200).json({ message: "Connexion réussie", uid: data.localId });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

/* --- mot de passe ounlié -- */
app.post("/api/password-reset", async (req, res) => {
    const { email } = req.body;

    if (!email) return res.status(400).json({ message: "Email requis" });

    try {
        // Vérifie si utilisateur existe
        await admin.auth().getUserByEmail(email);

        const link = await admin.auth().generatePasswordResetLink(email);

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.GMAIL_USER,
                pass: process.env.GMAIL_PASS
            }
        });

        await transporter.sendMail({
            from: `"ChezMoi" <${process.env.GMAIL_USER}>`,
            to: email,
            subject: "Réinitialisation mot de passe",
            text: `Cliquez sur ce lien pour réinitialiser votre mot de passe :\n${link}`
        });

        res.json({ message: "Email envoyé" });

    } catch (error) {
        res.status(400).json({ message: "Email introuvable" });
    }
});

/* ===================================================== */
/* ================= PUBLIER ANNONCE =================== */
/* ===================================================== */
app.post("/api/annonces", async (req, res) => {
    try {
        const { uid, titre, type_annonce, description, prix, ville, quartier, douche, contact, imagesBase64 } = req.body;

        if (!uid || !titre || !type_annonce || !description || !prix || !ville || !quartier || !contact) {
            return res.status(400).json({ message: "Champs obligatoires manquants" });
        }
        if (!imagesBase64 || imagesBase64.length === 0) {
            return res.status(400).json({ message: "Au moins une image est requise" });
        }

        const now = new Date();

        // Supprime annonces expirées
        const expiredSnapshot = await db.collection("annonces").where("expireAt", "<=", admin.firestore.Timestamp.fromDate(now)).get();
        for (const doc of expiredSnapshot.docs) {
            const data = doc.data();
            if (data.imagesDeleteUrls) {
                for (const deleteUrl of data.imagesDeleteUrls) {
                    try { await fetch(deleteUrl, { method: "GET" }); } 
                    catch(err){ console.error("Erreur suppression image Imgbb :", err); }
                }
            }

            // Supprimer favoris liés
            const favSnapshot = await db.collection("favorites")
                .where("annonceId", "==", doc.id)
                .get();

            for (const favDoc of favSnapshot.docs) {
                await favDoc.ref.delete();
            }

            await doc.ref.delete();
        }

        // Upload images sur Imgbb
        const uploadedImages = [];
        const imagesDeleteUrls = [];
        const apiKey = process.env.IMGBB_API_KEY;
        const expiration = 2592000; // 30 jours

        for (const base64 of imagesBase64) {
            const formData = new URLSearchParams();
            formData.append("image", base64.replace(/^data:image\/\w+;base64,/, ""));
            formData.append("expiration", expiration);

            const response = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
                method: "POST",
                body: formData
            });

            const data = await response.json();
            if (data.success) {
                uploadedImages.push(data.data.url);
                imagesDeleteUrls.push(data.data.delete_url);
            } else {
                console.error("Erreur Imgbb :", data);
            }
        }

        // Crée l'annonce Firebase avec Timestamp
        const expireAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 30*24*60*60*1000));

        const annonceRef = await db.collection("annonces").add({
            uid,
            titre,
            type_annonce,
            description,
            prix,
            ville,
            quartier,
            douche,
            contact,
            images: uploadedImages,
            imagesDeleteUrls,
            createdAt: admin.firestore.Timestamp.fromDate(now),
            expireAt
        });

        res.status(201).json({ message: "Annonce publiée avec succès !", id: annonceRef.id });

    } catch (err) {
        console.error("Erreur backend annonces :", err);
        res.status(500).json({ message: err.message });
    }
});

/* ===================================================== */
/* ================= OBTENIR ANNONCES ================= */
/* ===================================================== */
app.get("/api/annonces", async (req, res) => {
    try {
        const now = admin.firestore.Timestamp.now();

        // Supprime annonces expirées
        const expiredSnapshot = await db.collection("annonces").where("expireAt", "<=", now).get();
        for (const doc of expiredSnapshot.docs) {
            const data = doc.data();
            if (data.imagesDeleteUrls) {
                for (const deleteUrl of data.imagesDeleteUrls) {
                    try { await fetch(deleteUrl, { method: "GET" }); }
                    catch(err){ console.error("Erreur suppression image Imgbb :", err); }
                }
            }

            //  Supprimer favoris liés
            const favSnapshot = await db.collection("favorites")
                .where("annonceId", "==", doc.id)
                .get();

            for (const favDoc of favSnapshot.docs) {
                await favDoc.ref.delete();
            }

            await doc.ref.delete();
        }

        // Récupère annonces valides
        const snapshot = await db.collection("annonces").where("expireAt", ">", now).get();
        const annonces = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        res.json(annonces);

    } catch(err) {
        console.error("Erreur backend get annonces :", err);
        res.status(500).json({ message: err.message });
    }
});

// ================= GET TOUS LES COMPTES =================
app.get("/api/user/accounts", async (req, res) => {
    try {
        const snapshot = await db.collection("users").get();
        const users = snapshot.docs.map(doc => ({
            uid: doc.id,
            nom: doc.data().nom,
            email: doc.data().email,
            avatar: doc.data().avatar || "image/avatar.png" // si tu veux gérer les avatars
        }));
        res.json(users);
    } catch (err) {
        console.error("Erreur récupération comptes :", err);
        res.status(500).json({ message: err.message });
    }
});

/* ===================================================== */
/* ================== OBTENIR L'UTILISATEUR ========================= */
/* ===================================================== */
app.get("/api/user/:uid", async (req, res) => {
    try {
        const uid = req.params.uid;

        const userDoc = await db.collection("users").doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ message: "Utilisateur introuvable" });
        }

        res.json(userDoc.data());

    } catch (error) {
        console.error("Erreur récupération utilisateur :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ========= GET ANNONCES PAR UTILISATEUR ============== */
/* ===================================================== */
app.get("/api/annonces/user/:uid", async (req, res) => {
    try {
        const { uid } = req.params;
        const now = admin.firestore.Timestamp.now();

        const snapshot = await db.collection("annonces")
            .where("uid", "==", uid)       // filtrer par utilisateur
            .where("expireAt", ">", now)   // ne prendre que les annonces valides
            .get();

        const annonces = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.json(annonces);

    } catch (error) {
        console.error("Erreur récupération annonces utilisateur :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ================= FAVORIS ================= */

// Ajouter une annonce aux favoris
app.post("/api/favorites", async (req, res) => {
    try {
        const { uid, annonceId } = req.body;
        if (!uid || !annonceId) return res.status(400).json({ message: "UID et annonceId requis" });

        // Vérifie si déjà favori
        const favDoc = await db.collection("favorites")
            .where("uid", "==", uid)
            .where("annonceId", "==", annonceId)
            .get();

        if (!favDoc.empty) return res.status(400).json({ message: "Annonce déjà en favoris" });

        const docRef = await db.collection("favorites").add({
            uid,
            annonceId,
            createdAt: admin.firestore.Timestamp.now()
        });

        res.status(201).json({ message: "Ajouté aux favoris", id: docRef.id });

    } catch (error) {
        console.error("Erreur ajout favoris :", error);
        res.status(500).json({ message: error.message });
    }
});

// Supprimer une annonce des favoris
app.delete("/api/favorites", async (req, res) => {
    try {
        const { uid, annonceId } = req.body;
        if (!uid || !annonceId) return res.status(400).json({ message: "UID et annonceId requis" });

        const favSnapshot = await db.collection("favorites")
            .where("uid", "==", uid)
            .where("annonceId", "==", annonceId)
            .get();

        if (favSnapshot.empty) return res.status(404).json({ message: "Favori introuvable" });

        for (const doc of favSnapshot.docs) {
            await doc.ref.delete();
        }

        res.json({ message: "Favori supprimé" });

    } catch (error) {
        console.error("Erreur suppression favoris :", error);
        res.status(500).json({ message: error.message });
    }
});

// Obtenir toutes les annonces favorites d'un utilisateur
app.get("/api/favorites/:uid", async (req, res) => {
    try {
        const { uid } = req.params;
        const snapshot = await db.collection("favorites")
            .where("uid", "==", uid)
            .get();

        const favoriteIds = snapshot.docs.map(doc => doc.data().annonceId);
        res.json(favoriteIds);

    } catch (error) {
        console.error("Erreur récupération favoris :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ============ OBTENIR UNE ANNONCE PAR ID =========== */
/* ===================================================== */
app.get("/api/annonces/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const annonceDoc = await db.collection("annonces").doc(id).get();

        if (!annonceDoc.exists) {
            return res.status(404).json({ message: "Annonce introuvable" });
        }

        const annonce = annonceDoc.data();
        const now = admin.firestore.Timestamp.now();

        // Vérifie si l'annonce est expirée
        if (annonce.expireAt && annonce.expireAt <= now) {
            return res.status(410).json({ message: "Annonce expirée" });
        }

        res.json({ id: annonceDoc.id, ...annonce });
    } catch (error) {
        console.error("Erreur récupération annonce :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ================= SUPPRIMER ANNONCE ================= */
/* ===================================================== */
app.delete("/api/annonces/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { uid } = req.body; // on vérifie le propriétaire

        const annonceRef = db.collection("annonces").doc(id);
        const annonceDoc = await annonceRef.get();

        if (!annonceDoc.exists) {
            return res.status(404).json({ message: "Annonce introuvable" });
        }

        const annonce = annonceDoc.data();

        // Vérifie que c’est le propriétaire
        if (annonce.uid !== uid) {
            return res.status(403).json({ message: "Non autorisé" });
        }

        // Supprimer images Imgbb
        if (annonce.imagesDeleteUrls && annonce.imagesDeleteUrls.length > 0) {
            for (const deleteUrl of annonce.imagesDeleteUrls) {
                try {
                    await fetch(deleteUrl, { method: "GET" });
                } catch (err) {
                    console.error("Erreur suppression image Imgbb :", err);
                }
            }
        }

        // Supprimer aussi les favoris liés à cette annonce
        const favSnapshot = await db.collection("favorites")
            .where("annonceId", "==", id)
            .get();

        for (const doc of favSnapshot.docs) {
            await doc.ref.delete();
        }

        // Supprimer annonce Firestore
        await annonceRef.delete();

        res.json({ message: "Annonce supprimée avec succès" });

    } catch (error) {
        console.error("Erreur suppression annonce :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ================= MODIFIER UTILISATEUR ============== */
/* ===================================================== */

app.put("/api/user/:uid", async (req, res) => {
    try {
        const { uid } = req.params;
        const { nom, email, inscontact } = req.body;

        if (!nom || !email || !inscontact) {
            return res.status(400).json({ message: "Tous les champs sont obligatoires" });
        }

        // Vérifie si utilisateur existe
        const userRef = db.collection("users").doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({ message: "Utilisateur introuvable" });
        }

        // Mettre à jour Firestore
        await userRef.update({
            nom,
            email,
            inscontact,
            updatedAt: admin.firestore.Timestamp.now()
        });

        // Mettre à jour aussi email Firebase Auth
        await admin.auth().updateUser(uid, {
            email
        });

        res.json({ message: "Profil mis à jour avec succès" });

    } catch (error) {
        console.error("Erreur modification utilisateur :", error);
        res.status(500).json({ message: error.message });
    }
});

/* ===================================================== */
/* ================== SIGNALER UN PROBLEME ================== */
/* ===================================================== */

app.post("/api/report", async (req, res) => {
    const { nom, email, sujet, message, annonce } = req.body;

    // Validation simple
    if (!nom || !email || !sujet || !message || !annonce) {
        return res.status(400).json({ message: "Tous les champs sont obligatoires" });
    }

    try {
        // Création du transporteur avec nodemailer et Gmail
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.GMAIL_USER,     // ton email dans .env
                pass: process.env.GMAIL_PASS      // ton mot de passe d'application
            }
        });

        // Contenu du mail
        const mailOptions = {
            from: `"${nom}" <${email}>`,
            to: process.env.GMAIL_USER,          
            subject: `Signalement: ${sujet}`,
            text: 
`Nom: ${nom}
Email: ${email}

Message:
${message}

Annonce concernée:
- ID: ${annonce.id}
- Titre: ${annonce.titre}
- Type: ${annonce.type}
- Ville: ${annonce.ville}
- Quartier: ${annonce.quartier}
- Prix: ${annonce.prix} FCFA`
        };

        // Envoi du mail
        await transporter.sendMail(mailOptions);

        res.status(200).json({ message: "Signalement envoyé avec succès !" });
    } catch (error) {
        console.error("Erreur envoi mail report :", error);
        res.status(500).json({ message: "Impossible d'envoyer le signalement" });
    }
});

/* ===================================================== */
/* ================== PROPOSER UNE IDEE ================= */
/* ===================================================== */

app.post("/api/idea", async (req, res) => {

    const { nom, email, sujet, message } = req.body;

    if (!nom || !email || !sujet || !message) {
        return res.status(400).json({ message: "Tous les champs sont obligatoires" });
    }

    try {

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.GMAIL_USER,
                pass: process.env.GMAIL_PASS
            }
        });

        const mailOptions = {
            from: `"${nom}" <${email}>`,
            to: process.env.GMAIL_USER,
            subject: `💡 Nouvelle idée ChezMoi : ${sujet}`,
            text:
            `Nouvelle idée proposée depuis ChezMoi

            Nom: ${nom}
            Email: ${email}

            Titre de l'idée:
            ${sujet}

            Description:
            ${message}`
        };

        await transporter.sendMail(mailOptions);

        res.status(200).json({ message: "Idée envoyée avec succès !" });

    } catch (error) {

        console.error("Erreur envoi mail idée :", error);

        res.status(500).json({ message: "Impossible d'envoyer l'idée" });
    }

});

// ==================================================
// ==================== PAIEMENT DÉBLOCAGE ====================
// ====================================================
app.post("/api/payment/deblocage", async (req, res) => {

    const { name, msisdn, provider, amount, annonceId, description } = req.body;

    if (!name || !msisdn || !provider || !amount || !annonceId) {
        return res.status(400).json({ message: "Champs obligatoires manquants" });
    }

    try {

        const body = {
            accountId: YABETOOPAY_MERCHANT_ID,
            total: amount,
            currency: "xaf",

            successUrl: "https://chezmoi-app.com/payment-success",
            cancelUrl: "https://chezmoi-app.com/payment-cancel",

            metadata: {
                annonceId: annonceId,
                msisdn: msisdn
            },

            items: [
                {
                    productId: "deblocage_contact",
                    quantity: 1,
                    price: amount,
                    productName: description || "Déblocage contact propriétaire"
                }
            ]
        };

        const response = await fetch("https://buy.api.yabetoopay.com/v1/sessions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${YABETOOPAY_SECRET_KEY}`
            },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        console.log("Réponse Yabeto :", data);

        if (data.checkoutUrl) {

            res.json({
                message: "Paiement initié",
                redirectUrl: data.checkoutUrl
            });

        } else {

            res.status(400).json({
                message: "Erreur paiement",
                details: data
            });

        }

    } catch (error) {

        console.error("Erreur paiement debloquage :", error);

        res.status(500).json({
            message: error.message
        });

    }

});

// ===========================================
// ================= WEBHOOK YABETOO =================
// ===============================================

app.post("/webhook/yabetoo", express.json(), (req, res) => {
    const event = req.body;
    console.log("Webhook reçu :", event);

    if (event.type === "intent.succeeded") {
        console.log("Paiement réussi pour :", event.data.reference);
        // Pour l'instant, juste log. On implémentera le déblocage contact après.
    } else if (event.type === "intent.failed") {
        console.log("Paiement échoué :", event.data.reference);
    } else if (event.type === "intent.canceled") {
        console.log("Paiement annulé :", event.data.reference);
    }

    res.status(200).send("ok");
});

/* ===================================================== */
/* ================== LANCEMENT SERVEUR =============== */
/* ===================================================== */
app.listen(PORT, () => {
    console.log(`Backend ChezMoi lancé sur ${PORT}`);
});
