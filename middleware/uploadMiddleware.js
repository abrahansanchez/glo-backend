import multer from "multer";

const storage = multer.memoryStorage(); // keep audio in memory for ElevenLabs
const upload = multer({ storage });

export default upload;
