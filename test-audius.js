const axios = require("axios");

const API_BASE = "https://api.audius.co/v1";

async function testAudius() {
  try {
    console.log("Connecting to Audius API...\n");

    // Search for tracks
    const response = await axios.get(
      `${API_BASE}/tracks/search`,
      {
        params: {
          query: "Hindi music",
          limit: 5,
        },
        timeout: 15000,
      }
    );

    const tracks = response.data?.data || [];

    if (tracks.length === 0) {
      console.log("No tracks found. Try another search query.");
      return;
    }

    console.log("Audius API connected successfully!");
    console.log(`Tracks found: ${tracks.length}\n`);

    // Display track information
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];

      console.log("==================================");
      console.log(`${i + 1}. ${track.title || "Unknown title"}`);
      console.log(
        "Artist:",
        track.user?.name || "Unknown artist"
      );
      console.log("Track ID:", track.id);

      const streamUrl =
        `${API_BASE}/tracks/${track.id}/stream`;

      console.log("Stream URL:", streamUrl);

      // Check whether the stream endpoint responds
      try {
        const streamResponse = await axios.get(streamUrl, {
          responseType: "stream",
          timeout: 15000,
          validateStatus: () => true,
        });

        console.log(
          "Stream HTTP status:",
          streamResponse.status
        );

        console.log(
          "Content type:",
          streamResponse.headers["content-type"] || "Unknown"
        );

        // Stop reading the response; we only need to test it.
        streamResponse.data.destroy();
      } catch (error) {
        console.log(
          "Stream test failed:",
          error.response?.status || error.message
        );
      }
    }

    console.log("\nAudius test completed.");
  } catch (error) {
    console.error(
      "Audius API test failed:",
      error.response?.data || error.message
    );
  }
}

testAudius();