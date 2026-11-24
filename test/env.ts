// Imported first by tests: ESM evaluates imports in order, so config sees these values.
process.env.BASE_URL = "http://localhost:3999";
process.env.PORT = "3999";
process.env.DB_PATH = ":memory:";
process.env.POSTSMITH_JOB_SPEED = "0.01";
process.env.STRIPE_SECRET_KEY = "";
