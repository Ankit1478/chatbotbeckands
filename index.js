require('dotenv').config();
const { ChromaClient, OpenAIEmbeddingFunction } = require('chromadb');
const OpenAI = require("openai");
const express = require('express');
const admin = require('firebase-admin');
const app = express();
const port = 8080;
const cors = require('cors');

app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK using environment variables
admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
    databaseURL: 'https://foodmatto-default-rtdb.firebaseio.com/'
});

const db = admin.database();

// Initialize ChromaDB Client using environment variables
const client = new ChromaClient({
    path: process.env.CHROMA_CLIENT_PATH
});


// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});


const embedder = new OpenAIEmbeddingFunction({ openai_api_key: process.env.OPENAI_API_KEY });

let collection;
let latestStoryId = null;

// Function to initialize the Chroma collection
async function initializeChromaCollection() {
    try {
        const collections = await client.listCollections();
        const existingCollection = collections.find(c => c.name === "story_summaries");

        if (existingCollection) {
            collection = await client.getCollection({
                name: "story_summaries",
                embeddingFunction: embedder
            });
            console.log("Existing Chroma collection retrieved successfully.");
        } else {
            collection = await client.createCollection({
                name: "story_summaries",
                embeddingFunction: embedder
            });
            console.log("New Chroma collection created successfully.");
        }

        // Rehydrate ChromaDB from Firebase if needed
        await rehydrateChromaCollectionFromFirebase();
    } catch (error) {
        console.error("Error initializing Chroma collection:", error);
        process.exit(1);
    }
}

// Function to rehydrate Chroma collection from Firebase
async function rehydrateChromaCollectionFromFirebase() {
    const storiesRef = db.ref('stories');
    const snapshot = await storiesRef.once('value');
    const stories = snapshot.val();

    if (stories) {
        for (let storyId in stories) {
            const { original_story, summary } = stories[storyId];
            await collection.add({
                ids: [storyId],
                documents: [summary],
                metadatas: [{ original_story: original_story }]
            });
        }
        console.log("ChromaDB rehydrated with data from Firebase.");
    } else {
        console.log("No data found in Firebase to rehydrate ChromaDB.");
    }
}

// Function to summarize a story using OpenAI
async function summarizeStory(story) {
    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
            { role: "system", content: "You are a helpful assistant that can summarize information concisely." },
            { role: "user", content: `Please summarize the following story: "${story}"` },
        ],
    });
    return completion.choices[0].message.content.trim();
}

// Function to add and summarize a new story
async function addStory(story) {
    const summary = await summarizeStory(story);
    const storyId = Date.now().toString();

    // Store the summary in ChromaDB
    await collection.add({
        ids: [storyId],
        documents: [summary],
        metadatas: [{ original_story: story }]
    });

    // Store the summary and original story in Firebase Realtime Database
    await db.ref('stories/' + storyId).set({
        original_story: story,
        summary: summary
    });

    // Update the latestStoryId to the current story
    latestStoryId = storyId;

    console.log("Story added and summarized successfully!\n");
}

async function giveCharacterName(story) {
    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
            { role: "system", content: "You are a helpful assistant. Please identify and return only the character names from the following story, separated by commas, with no additional text." },
            { role: "user", content: `Extract and return only the character names from this story: "${story}"` },
        ],
    });
    const characterNames = completion.choices[0].message.content.trim();
    
    // Ensure there are no additional text
    return characterNames.split(',').map(name => name.trim()).join(', ');
}

// Function to generate a response based on the latest summarized story
async function getResponseBasedOnLatestStory(userQuery, characterName) {
    try {
        // Fetch the latest summary directly using the latestStoryId
        const snapshot = await db.ref('stories/' + latestStoryId).once('value');
        const storyData = snapshot.val();

        if (!storyData) {
            console.log("No relevant story found. Please add a new story.");
            return "No relevant story found.";
        }

        const relevantSummary = storyData.summary;

        // Generate a response based on the relevant summary
        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: "You are a helpful assistant with access to summarized memories." },
                { role: "user", content: `Here is a summarized story: "${relevantSummary}"` },
                { role: "user", content: `As the character "${characterName}", please answer this question: "${userQuery}"` },
            ],
        });

        return completion.choices[0].message.content;
    } catch (error) {
        console.error("Error generating response based on the latest story:", error);
        return "An error occurred while processing your request.";
    }
}

// Route to add a new story and summarize it
app.post('/add', async (req, res) => {
    const { story } = req.body;
    try {
        await addStory(story);
        res.status(200).json({ message: 'Story added and summarized successfully!' });
    } catch (error) {
        console.error("Error adding story:", error);
        res.status(500).json({ error: 'An error occurred while adding the story.' });
    }
});

app.post("/charactername", async (req, res) => {
    const { story } = req.body;
    try {
        const response = await giveCharacterName(story);
        res.status(200).json({ response });
    } catch (error) {
        console.error("Error processing query:", error);
        res.status(500).json({ error: 'An error occurred while processing your query.' });
    }
});

// Route to ask a question based on the latest summarized story
app.post('/ask', async (req, res) => {
    const { query, characterName } = req.body;
    try {
        const response = await getResponseBasedOnLatestStory(query, characterName);
        res.status(200).json({ response });
    } catch (error) {
        console.error("Error processing query:", error);
        res.status(500).json({ error: 'An error occurred while processing your query.' });
    }
});
app.get("/",(req, res)=>{
    res.send("running")
})

// Initialize the Chroma collection before starting the server
initializeChromaCollection().then(() => {
    app.listen(port, () => console.log(`App listening on port ${port}!`));
}).catch(error => {
    console.error("Failed to initialize the application:", error);
    process.exit(1);
});
