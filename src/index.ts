// eslint-disable-next-line import/no-nodejs-modules
import process from "node:process";

const CLI_ARGV_OFFSET = 2;

const run = (argv = process.argv.slice(CLI_ARGV_OFFSET)): void => {
	// eslint-disable-next-line no-console
	console.log("Hello from pickup!", argv);
};

export default run;
