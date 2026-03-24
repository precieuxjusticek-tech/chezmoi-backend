const path = require("path");
const admin = require("firebase-admin");

// Chemin absolu pour éviter les erreurs de path
const serviceAccountPath = path.join(__dirname, "firebaseKey.json");
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
(async () => {
    try {
        const snapshot = await db.collection("annonces").limit(1).get();
        console.log("Firestore OK :", snapshot.size);
    } catch (err) {
        console.error("Erreur Firestore :", err);
    }
})();