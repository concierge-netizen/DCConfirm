/**
 * GET /portal/api/config — public Clerk publishable key + portal status.
 */
exports.handler = async () => {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({
      clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || '',
      shellMode: false,
      version: 'monday-1'
    }),
  };
};
