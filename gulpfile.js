const path = require('node:path');
const { task, src, dest, parallel } = require('gulp');

task('build:icons', copyIcons);
task('build:codex', copyCodex);
task('build:assets', parallel(copyIcons, copyCodex));

function copyIcons() {
	const nodeSource = path.resolve('nodes', '**', '*.{png,svg}');
	const nodeDestination = path.resolve('dist', 'nodes');

	src(nodeSource).pipe(dest(nodeDestination));

	const credSource = path.resolve('credentials', '**', '*.{png,svg}');
	const credDestination = path.resolve('dist', 'credentials');

	return src(credSource).pipe(dest(credDestination));
}

function copyCodex() {
	const codexSource = path.resolve('nodes', '**', '*.node.json');
	const codexDestination = path.resolve('dist', 'nodes');

	return src(codexSource).pipe(dest(codexDestination));
}
