import process from 'node:process';

export function run(argv = process.argv.slice(2)): void {
	console.log('Hello from pickup!', argv);
}
